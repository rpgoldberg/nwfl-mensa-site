import { describe, expect, it } from 'vitest';
import { addressRefusal, isPublicAddress } from '../src/addr.js';

describe('addressRefusal: only global unicast addresses may be dialled', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['192.0.2.10', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.0.8', 'special'],
    ['192.88.99.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:10.0.0.1', 'ipv4-mapped'],
    ['::ffff:8.8.8.8', 'ipv4-mapped'],
    ['::ffff:a00:1', 'ipv4-mapped'],
    ['::10.0.0.1', 'ipv4-compatible'],
    ['fc00::1', 'ula'],
    ['fd12:3456::1', 'ula'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'scoped'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['2002:a00:1::1', '6to4'],
    ['2001:0:4136:e378::1', 'teredo'],
    ['2001:10::1', 'orchid'],
    ['2001:20::1', 'orchid'],
    ['2001:2::1', 'benchmarking'],
    ['64:ff9b::a00:1', 'nat64'],
    ['64:ff9b:1::1', 'nat64'],
    ['100::1', 'discard'],
    ['fec0::1', 'not-global'],
    ['4000::1', 'not-global'],
  ])('%s is refused as %s', (ip, reason) => {
    expect(addressRefusal(ip)).toBe(reason);
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '100.128.0.1', '11.0.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860::8888'])(
    '%s is public',
    (ip) => {
      expect(addressRefusal(ip)).toBeNull();
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it.each(['', 'localhost', '2130706433', '0177.0.0.1', '1.2.3', '1.2.3.4.5', '::g', '1::2::3', '[::1]', ' 8.8.8.8'])('%j is not an address and is refused', (text) => {
    expect(addressRefusal(text)).toBe('not-an-address');
  });
});
