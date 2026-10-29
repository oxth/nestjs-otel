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
  it('renders a RegExp as its literal', () => {
    expect(patternToString(/orders\..*/)).toBe('/orders\\..*/');
    expect(patternToString(/a/gi)).toBe('/a/gi');
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

describe('subclasses map like their base', () => {
  // Fakes: the library matches class names along the prototype chain.
  class ClientKafka {}
  class MyKafka extends ClientKafka {}
  class MyKafkaV2 extends MyKafka {}
  class KafkaContext {}
  class MyKafkaContext extends KafkaContext {}
  it('client', () => {
    expect(systemOfClient(new MyKafka())).toBe('kafka');
    expect(systemOfClient(new MyKafkaV2())).toBe('kafka');
    expect(systemOfClient({})).toBe('nestjs');
    expect(systemOfClient(Object.create(null))).toBe('nestjs');
  });
  it('context', () => {
    expect(systemOfContext(new MyKafkaContext())).toBe('kafka');
    expect(systemOfContext({})).toBeUndefined();
    expect(systemOfContext('KafkaContext')).toBeUndefined();
  });
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
