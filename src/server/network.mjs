import net from 'node:net';

export function lanPolicy({ address, prefixLength, certificateSha256 }) {
  const privateBits = address?.startsWith('10.') ? 8 : address?.startsWith('192.168.') ? 16 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 12 : 33;
  if (!net.isIPv4(address || '') || !Number.isInteger(prefixLength) || prefixLength < privateBits || prefixLength > 32 || !/^[A-F0-9]{64}$/.test(certificateSha256 || '')) {
    throw new Error('Invalid LAN settings. Run scripts/enable-lan.ps1 on your home network.');
  }
  const subnet = new net.BlockList();
  subnet.addSubnet(address, prefixLength, 'ipv4');
  const origin = `https://${address}:8443`, setupOrigin = `http://${address}:8789`;
  return {
    address, origin, setupOrigin, certificateSha256,
    allows(req, setup = false) {
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      return net.isIPv4(remote || '') && subnet.check(remote, 'ipv4') &&
        req.headers.host === new URL(setup ? setupOrigin : origin).host;
    }
  };
}

export function browserOrigin(req, lan) {
  if (req.socket.encrypted) return lan?.allows(req) ? lan.origin : null;
  if (req.headers.host === '127.0.0.1:8787' && ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return 'http://127.0.0.1:8787';
  return null;
}
