import { describe, expect, it } from 'vitest';
import { patternToString, systemOfClient, systemOfContext } from '../../src/microservices/pattern';

function named(name: string): object {
  return new ({ [name]: class {} })[name]();
}

describe('patternToString', () => {
  it('returns strings as-is', () => {
    expect(patternToString('users.get')).toBe('users.get');
  });
  it('sorts keys recursively', () => {
    expect(patternToString({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('handles circular objects without throwing', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(patternToString(o)).toBe('[object Object]');
  });
});

describe('systemOfClient', () => {
  it.each([
    ['ClientTCP', 'tcp'],
    ['ClientRedis', 'redis'],
    ['ClientKafka', 'kafka'],
    ['ClientRMQ', 'rabbitmq'],
    ['ClientNats', 'nats'],
    ['ClientMqtt', 'mqtt'],
    ['ClientGrpcProxy', 'grpc'],
    ['Whatever', 'nestjs'],
  ])('%s -> %s', (n, s) => expect(systemOfClient(named(n))).toBe(s));
});

describe('systemOfContext', () => {
  it.each([
    ['TcpContext', 'tcp'],
    ['RedisContext', 'redis'],
    ['KafkaContext', 'kafka'],
    ['RmqContext', 'rabbitmq'],
    ['NatsContext', 'nats'],
    ['MqttContext', 'mqtt'],
  ])('%s -> %s', (n, s) => expect(systemOfContext(named(n))).toBe(s));
  it('unknown gives undefined', () => {
    expect(systemOfContext(named('Other'))).toBeUndefined();
    expect(systemOfContext(undefined)).toBeUndefined();
  });
});
