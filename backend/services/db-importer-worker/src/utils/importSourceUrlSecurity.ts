import { lookup } from 'dns/promises';
import { isIP } from 'net';

const normalizeHostname = (hostname: string): string => hostname.replace(/^\[(.*)]$/, '$1');

const isBlockedIPv4 = (address: string): boolean => {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
};

const isBlockedIPv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  const mappedIPv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4) {
    return isBlockedIPv4(mappedIPv4[1]);
  }

  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
};

const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIPv4(address);
  }
  if (family === 6) {
    return isBlockedIPv6(address);
  }
  return true;
};

export const validateImportSourceUrl = async (sourceUrl: string): Promise<URL> => {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:') {
    throw new Error('Import source URL must use https');
  }
  if (url.username || url.password) {
    throw new Error('Import source URL must not include credentials');
  }

  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const resolvedAddresses = literalFamily
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (resolvedAddresses.length === 0 || resolvedAddresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('Import source URL resolves to a blocked network address');
  }

  return url;
};