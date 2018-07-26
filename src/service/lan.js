'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.core;

const TCP_MIN_PORT = 1716;
const TCP_MAX_PORT = 1764;
const UDP_PORT = 1716;

const IP_PATTERN = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$|^(([a-zA-Z]|[a-zA-Z][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z]|[A-Za-z][A-Za-z0-9\-]*[A-Za-z0-9])$|^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$/;


/**
 * A convenience function for validating IP addresses
 *
 * @param {string} address - An IPv4 or IPv6 address (without port number)
 */
function ip_is_valid(address) {
    return IP_PATTERN.test(address);
}


/**
 * Lan.ChannelService consists of two parts.
 *
 * The TCP Listener listens on a port (usually 1716) and constructs a Channel
 * object from the incoming Gio.TcpConnection, emitting 'channel::'.
 *
 * The UDP Listener listens on a port 1716 for incoming JSON identity packets
 * which will have the TCP port for connections, while the TCP address is taken
 * from the UDP packet itself. If the device is not known, the address not
 * explicitly allowed and we're not "discoverable", we respond to  a TCP port for connection, taking the address from the
 * sender, emitting 'packet::'. It also broadcasts these packets to 255.255.255.255.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectLanChannelService'
}, class ChannelService extends GObject.Object {

    _init() {
        super._init();

        this.service = Gio.Application.get_default();

        this._initTcpListener();
        this._initUdpListener();

        // If we can't receive channels
        if (this._tcp === undefined && this._udp === undefined) {
            throw new Error();
        }

        // Monitor network changes
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed',
            this._onNetworkChanged.bind(this)
        );
    }

    get allowed() {
        if (this._allowed === undefined) {
            this._allowed = new Set();
        }

        return this._allowed;
    }

    get port() {
        if (this._port === undefined) {
            return 0;
        }

        return this._port;
    }

    _onNetworkChanged(monitor, network_available) {
        if (network_available) {
            this.broadcast();
        }
    }

    _initTcpListener() {
        this._tcp = new Gio.SocketService();
        let port = TCP_MIN_PORT;

        while (true) {
            try {
                this._tcp.add_inet_port(port, null);
            } catch (e) {
                if (port < TCP_MAX_PORT) {
                    port += 1;
                    continue;
                } else {
                    logWarning('Unable to bind to TCP port', 'Lan.ChannelService');
                    this._tcp.stop();
                    this._tcp.close();
                    return;
                }
            }

            if (this._tcp.active) {
                this._port = port;
                break;
            }
        }

        this._tcp.connect('incoming', this._onIncomingChannel.bind(this));

        log(`GSConnect: Using TCP port ${port}`);
    }

    async _onIncomingChannel(listener, connection) {
        try {
            let channel = new Core.Channel(null, 'tcp');
            let host = connection.get_remote_address().address.to_string();

            debug(host, 'incoming channel');

            // Accept the connection
            let success = await channel.accept(connection);

            if (!success) {
                throw Error('failed to accept connection');
            }

            channel.identity.body.tcpHost = host;
            channel.identity.body.tcpPort = '1716';

            // Bail if the deviceId is missing
            if (!channel.identity.body.hasOwnProperty('deviceId')) {
                logWarning('missing deviceId', channel.identity.body.deviceName);
                channel.close();
                return;
            }

            let device = this.service._devices.get(channel.identity.body.deviceId);

            switch (true) {
                // An existing device
                case (device !== undefined):
                    break;

                // The host is allowed (responding to a "direct" broadcast)
                case this.allowed.has(host):
                    device = await this.service._ensureDevice(channel.identity);
                    break;

                // The service is discoverable
                case this.service.discoverable:
                    device = await this.service._ensureDevice(channel.identity);
                    break;

                // ...otherwise bail
                default:
                    throw Error('device not allowed');
            }

            // Attach a device to the channel
            channel.attach(device);
        } catch (e) {
            logWarning(e, connection.get_remote_address().address.to_string());
        }
    }

    // TODO: support IPv6?
    _initUdpListener() {
        this._udp = new Gio.Socket({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP,
            broadcast: true
        });
        this._udp.init(null);

        try {
            let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: UDP_PORT
            });

            this._udp.bind(addr, false);
        } catch (e) {
            logWarning('Unable to bind to UDP port 1716', 'Lan.ChannelService');
            this._udp.close();
            return;
        }

        // Default broadcast address
        this._udp_address = Gio.InetSocketAddress.new_from_string(
            '255.255.255.255',
            UDP_PORT
        );

        // Input stream
        this._udp_stream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: this._udp.fd,
                close_fd: false
            })
        });

        // Watch input stream for incoming packets
        this._udp_source = this._udp.create_source(GLib.IOCondition.IN, null);
        this._udp_source.set_callback(this._onIncomingPacket.bind(this));
        this._udp_source.attach(null);

        log(`GSConnect: Using UDP port 1716`);
    }

    async _onIncomingPacket() {
        try {
            // Most of the datagram methods don't work in GJS, so we "peek" for
            // the host address first...
            let host = this._udp.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            )[1].address.to_string();

            // ...then read the packet from a stream, filling in the tcpHost
            let data = this._udp_stream.read_line(null)[0];
            let packet = new Core.Packet(data.toString());
            packet.body.tcpHost = host;

            // Bail if the deviceId is missing
            if (!packet.body.hasOwnProperty('deviceId')) {
                logWarning('missing deviceId', packet.body.deviceName);
                return;
            }

            // Silently ignore our own broadcasts
            if (packet.body.deviceId === this.service.identity.body.deviceId) {
                return;
            }

            debug(packet.body.deviceName, 'Received broadcast');

            let device = this.service._devices.get(packet.body.deviceId);

            switch (true) {
                // Proceed if this is an existing device...
                case (device !== undefined):
                    break;

                // Or the host is explicitly allowed...
                case this.allowed.has(host):
                    device = await this.service._ensureDevice(packet);
                    break;

                // Or the service is discoverable...
                case this.service.discoverable:
                    device = await this.service._ensureDevice(packet);
                    break;

                // ...otherwise bail
                default:
                    logWarning('device not allowed', packet.body.deviceName);
                    return;
            }

            // Silently ignore broadcasts from connected devices, but update
            // from the identity packet
            if (device._channel !== null) {
                debug('already connected');
                device._handleIdentity(packet);
                return;
            }

            // Create a new channel
            let channel = new Core.Channel(packet.body.deviceId, 'tcp');
            channel.identity = packet;
            device._channel = channel;

            let addr = Gio.InetSocketAddress.new_from_string(
                packet.body.tcpHost,
                packet.body.tcpPort
            );

            // Connect the channel and attach it to the device on success
            let success = await channel.open(addr);

            if (success) {
                channel.attach(device);
            } else {
                device._channel = null;
            }
        } catch (e) {
            logWarning(e, 'Reading UDP Packet');
        }
    }

    /**
     * Broadcast an identity packet
     *
     * If @address is not %null it may specify an IPv4 or IPv6 address to send
     * the identity packet directly to, otherwise it will be broadcast to the
     * default address, 255.255.255.255.
     *
     * @param {string} [address] - An optional target IPv4 or IPv6 address
     */
    broadcast(address=null) {
        debug('broadcasting...');

        try {
            // Remember manual addresses so we know to accept connections
            if (address instanceof Gio.InetSocketAddress) {
                this.allowed.add(address.address.to_string());
            } else {
                address = this._udp_address;
            }

            this._udp.send_to(address, `${this.service.identity}`, null);
        } catch (e) {
            logWarning(e);
        }
    }

    destroy() {
        this._networkMonitor.disconnect(this._networkChangedId);

        this._tcp.stop();
        this._tcp.close();

        this._udp_source.destroy();
        this._udp_stream.close(null);
        this._udp.close();
    }
});


/**
 * Lan File Transfers
 */
var Transfer = GObject.registerClass({
    GTypeName: 'GSConnectLanTransfer',
}, class Transfer extends Core.Transfer {

    /**
     * Connect to @port and read from the remote output stream into the local
     * input stream.
     *
     * When finished the channel and local input stream will be closed whether
     * or not the transfer succeeds.
     *
     * @param {Number} port - The port the transfer is listening for connection
     * @return {Boolean} - %true on success or %false on fail
     */
    async download(port) {
        let result;

        try {
            this._connection = await new Promise((resolve, reject) => {
                // Connect
                let client = new Gio.SocketClient();

                // Use the address from GSettings with @port
                let address = Gio.InetSocketAddress.new_from_string(
                    this.device.settings.get_string('tcp-host'),
                    port
                );

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._clientEncryption(this._connection);
            this.input_stream = this._connection.get_input_stream();

            // Start the transfer
            result = await this._transfer();
        } catch (e) {
            logError(e, this.device.name);
            result = false;
        } finally {
            this.close();
            return result;
        }
    }

    /**
     * Start listening on the first available port for an incoming connection,
     * then send @packet with the payload transfer info. When the connection is
     * accepted write to the remote input stream from the local output stream.
     *
     * When finished the channel and local output stream will be closed whether
     * or not the transfer succeeds.
     *
     * @param {Core.Packet} packet - The packet to send the transfer with
     * @return {Boolean} - %true on success or %false on fail
     */
    async upload(packet) {
        let port = 1739;
        let result;

        try {
            // Start listening on the first available port between 1739-1764
            this._listener = new Gio.SocketListener();

            while (true) {
                try {
                    this._listener.add_inet_port(port, null);
                } catch (e) {
                    if (port < TCP_MAX_PORT) {
                        port += 1;
                        continue;
                    } else {
                        throw new Error('Failed to open port');
                    }
                }

                break;
            }

            // Await the incoming connection
            let connection = new Promise((resolve, reject) => {
                this._listener.accept_async(null, (source, res) => {
                    try {
                        resolve(this._listener.accept_finish(res)[0]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Notify the device we're ready
            packet.body.payloadHash = this.checksum;
            packet.payloadSize = this.size;
            packet.payloadTransferInfo = { port: port };
            this.device.sendPacket(packet);

            // Accept the connection and configure the channel
            this._connection = await connection;
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._serverEncryption(this._connection);
            this.output_stream = this._connection.get_output_stream();

            // Start the transfer
            result = await this._transfer();
        } catch (e) {
            logError(e, this.device.name);
            result = false;
        } finally {
            this.close();
            return result;
        }
    }
});

