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

const expandIPv6 = (address: string): number[] | undefined => {
  const sections = address.split('::');
  if (sections.length > 2) {
    return undefined;
  }
  const [head = '', tail = ''] = sections;

  const parseGroups = (section: string): number[] | undefined => {
    if (section === '') {
      return [];
    }

    const groups = section.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
      return undefined;
    }

    return groups.map((group) => parseInt(group, 16));
  };

  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);
  if (!headGroups || !tailGroups) {
    return undefined;
  }

  const missingGroups = 8 - headGroups.length - tailGroups.length;
  if (address.includes('::')) {
    if (missingGroups < 1) {
      return undefined;
    }

    return [...headGroups, ...Array(missingGroups).fill(0), ...tailGroups];
  }

  if (missingGroups !== 0) {
    return undefined;
  }

  return headGroups;
};

const dottedDecimalToHexGroups = (address: string): string | undefined => {
  const octets = address.split('.').map((octet) => Number(octet));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }

  return [
    (octets[0] << 8) | octets[1],
    (octets[2] << 8) | octets[3],
  ].map((group) => group.toString(16)).join(':');
};

const parseIPv4MappedIPv6 = (address: string): string | undefined => {
  const dottedDecimal = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  const dottedDecimalGroups = dottedDecimal ? dottedDecimalToHexGroups(dottedDecimal[2]) : undefined;
  const normalizedAddress = dottedDecimal && dottedDecimalGroups ? `${dottedDecimal[1]}${dottedDecimalGroups}` : address;
  const groups = expandIPv6(normalizedAddress);
  if (!groups
    || groups.length !== 8
    || groups.slice(0, 5).some((group) => group !== 0)
    || groups[5] !== 0xffff) {
    return undefined;
  }

  const [high, low] = groups.slice(6);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
};

const isBlockedIPv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  const mappedIPv4 = parseIPv4MappedIPv6(normalized);
  if (mappedIPv4) {
    return isBlockedIPv4(mappedIPv4);
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