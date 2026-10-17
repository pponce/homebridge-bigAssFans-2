import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as net from 'net';
import { mock } from 'node:test';

import { __test__, BigAssFans_i6PlatformAccessory } from '../src/platformAccessory';
import { parseCapabilitiesFromSlipData, parseMacFromSlipData, suggestCapabilityConfig, summarizeCapabilityExposure } from '../src/protocol';
import { emptyNightLightState, NightLightCoordinator, nightLightCommand, type NightLightState } from '../src/nightlight';

class FakeHapStatusError extends Error {
  constructor(public readonly hapStatus: number) {
    super(`HAP Status Error: ${hapStatus}`);
  }
}

class FakeSocket extends EventEmitter {
  public writes: Buffer[] = [];
  public keepAlive = false;
  public destroyed = false;
  public writable = true;

  write(buffer: Buffer) {
    this.writes.push(buffer);
    return true;
  }

  setKeepAlive(enabled: boolean) {
    this.keepAlive = enabled;
    return this;
  }

  override removeAllListeners(eventName?: string | symbol): this {
    super.removeAllListeners(eventName);
    return this;
  }

  destroy(_error?: Error) {
    this.destroyed = true;
    return this;
  }
}

class FakeService {
  public values = new Map<string, unknown>();
  public characteristics = new Set<string>();
  public setters = new Map<string, (value: unknown) => unknown>();

  updateCharacteristic(characteristic: string, value: unknown) {
    this.values.set(characteristic, value);
    return this;
  }

  public name?: string;

  constructor(
    public displayName: string,
    public UUID = displayName,
    public subtype?: string,
  ) {}

  setCharacteristic(characteristic: string, _value: unknown) {
    this.characteristics.add(characteristic);
    if (characteristic === 'Name' || characteristic === 'ConfiguredName') {
      this.name = String(_value);
    }
    return this;
  }

  testCharacteristic(characteristic: string) {
    return this.characteristics.has(characteristic);
  }

  addCharacteristic(characteristic: string) {
    this.characteristics.add(characteristic);
    return this;
  }

  getCharacteristic(characteristic: string) {
    const service = this;
    return {
      setProps() { return this; },
      onGet() {
        return this;
      },
      onSet(handler: (value: unknown) => unknown) {
        service.setters.set(characteristic, handler);
        return this;
      },
    };
  }
}

class FakeAccessory {
  public services: FakeService[] = [];
  public context: { device: object; whiteLightMemory?: { down?: number; up?: number }; nightLightBrightness?: number } = { device: {} };

  constructor() {
    this.services.push(new FakeService('AccessoryInformation'));
  }

  getService(service: string | { UUID: string }) {
    if (typeof service === 'string') {
      const normalized = service.toLowerCase();
      return this.services.find((candidate) => [
        candidate.displayName,
        candidate.name,
        candidate.subtype,
        candidate.UUID,
      ].some((value) => String(value || '').toLowerCase() === normalized));
    }

    return this.services.find((candidate) => candidate.UUID === service.UUID);
  }

  getServiceById(service: string | { UUID: string }, subtype: string) {
    const uuid = typeof service === 'string' ? service : service.UUID;
    return this.services.find((candidate) => candidate.UUID === uuid && candidate.subtype === subtype);
  }

  addService(type: string | { UUID: string }, displayName?: string, subtype?: string) {
    const uuid = typeof type === 'string' ? type : type.UUID;
    const service = new FakeService(displayName || uuid, uuid, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service: FakeService) {
    this.services = this.services.filter((existingService) => existingService !== service);
  }

  hasService(service: string | { UUID: string }) {
    return this.getService(service) !== undefined;
  }
}

function createTestAccessoryState() {
  const warnings: string[] = [];
  const debugs: string[] = [];
  const infos: string[] = [];

  return {
    warnings,
    debugs,
    infos,
    state: {
      ProbeFrequency: 0,
      client: undefined as FakeSocket | undefined,
      IP: '127.0.0.1',
      Name: 'Test Fan',
      chunkFragment: Buffer.alloc(0),
      funQueue: [],
      targetBulb: -1,
      bulbCount: 0,
      capabilitiesEstablished: false,
      uptimeMinutes: 0,
      enableDebugPort: false,
      fanAutoSwitchOn: false,
      showFanAutoSwitch: false,
      downlightEquipped: undefined as boolean | 'auto' | undefined,
      uplightEquipped: undefined as boolean | 'auto' | undefined,
      capabilities: {
        hasTempSensor: false,
        hasHumiditySensor: false,
        hasOccupancySensor: false,
        hasLight: false,
        hasLightSensor: false,
        hasColorTempControl: false,
        hasFan: true,
        hasSpeaker: false,
        hasPiezo: false,
        hasLEDIndicators: false,
        hasUplight: false,
        hasUVCLight: false,
        hasStandbyLED: false,
        hasEcoMode: false,
      },
      fanStates: {
        Active: 0,
        CurrentFanState: 0,
        TargetFanState: 0,
        RotationSpeed: 0,
        RotationDirection: 1,
        homeShieldUp: false,
      },
      debugLevels: {
        characteristics: 0,
        newcode: 0,
        network: 0,
        reconnect: 0,
        progress: 0,
        protoparse: 0,
        light: 0,
        funstack: 0,
        cluing: 0,
        redflags: 0,
      },
      lastDebugMessage: '',
      lastDebugMessageTag: '',
      messagesLogged: new Set<string>(),
      lastRotationSpeedRequestAt: 0,
      lastRotationSpeedRequestPercent: undefined as number | undefined,
      lastRotationSpeedRequestDeviceSpeed: undefined as number | undefined,
      lastFanActiveRequestAt: 0,
      lastFanActiveRequestValue: undefined as number | undefined,
      lastFanActiveWriteAt: 0,
      lastFanActiveWriteValue: undefined as number | undefined,
      pendingRotationSpeedWrite: undefined as Buffer | undefined,
      pendingRotationSpeedWriteTimeout: undefined as ReturnType<typeof setTimeout> | undefined,
      pendingRotationSpeedRequestPercent: undefined as number | undefined,
      pendingRotationSpeedRequestDeviceSpeed: undefined as number | undefined,
      expectedRotationSpeed: undefined as number | undefined,
      ignoreUnexpectedRotationSpeedUntil: 0,
      platform: {
        Characteristic: {
          Active: 'Active',
          CurrentFanState: 'CurrentFanState',
          RotationSpeed: 'RotationSpeed',
          TargetFanState: 'TargetFanState',
          On: 'On',
        },
        log: {
          warn: (message: string) => warnings.push(message),
          error: (_message: string) => undefined,
          info: (message: string) => infos.push(message),
          debug: (message: string) => debugs.push(message),
        },
      },
      fanService: {
        updates: [] as Array<{ characteristic: string; value: number }>,
        updateCharacteristic(characteristic: string, value: number) {
          this.updates.push({ characteristic, value });
        },
      },
      fanAutoSwitchService: {
        updates: [] as Array<{ characteristic: string; value: boolean }>,
        updateCharacteristic(characteristic: string, value: boolean) {
          this.updates.push({ characteristic, value });
        },
      },
    },
  };
}

function createTestServiceState() {
  const logs: string[] = [];
  const updatedAccessories: FakeAccessory[] = [];
  const accessory = new FakeAccessory();
  accessory.addService('OccupancySensor', 'Fan Occupancy', 'occupancySensor-1');
  accessory.addService('OccupancySensor', 'Light Occupancy', 'occupancySensor-2');
  accessory.addService('TemperatureSensor', 'Bedroom Temperature');
  accessory.addService('HumiditySensor', 'Bedroom Humidity');
  accessory.addService('Switch', 'UVC', 'switch-6');
  accessory.addService('Switch', 'Eco Mode', 'switch-5');
  accessory.addService('Lightbulb', 'Bedroom Uplight', 'light-2');

  return {
    accessory,
    state: {
      accessory,
      Name: 'Test Fan',
      MAC: '20:F8:5E:00:00:00',
      noLights: false,
      showFanOccupancySensor: true,
      showLightOccupancySensor: true,
      showTemperature: true,
      showHumidity: true,
      showEcoModeSwitch: true,
      showStandbyLED: false,
      enableIncrementalButtons: false,
      capabilities: {
        hasTempSensor: false,
        hasHumiditySensor: false,
        hasOccupancySensor: false,
        hasLight: false,
        hasLightSensor: false,
        hasColorTempControl: false,
        hasFan: false,
        hasSpeaker: false,
        hasPiezo: false,
        hasLEDIndicators: false,
        hasUplight: false,
        hasUVCLight: false,
        hasStandbyLED: false,
        hasEcoMode: false,
      },
      debugLevels: {
        newcode: 0,
        progress: 0,
      },
      lastDebugMessage: '',
      lastDebugMessageTag: '',
      messagesLogged: new Set<string>(),
      platform: {
        Service: {
          AccessoryInformation: 'AccessoryInformation',
          Fan: 'Fan',
          Fanv2: 'Fanv2',
          Lightbulb: 'Lightbulb',
          Switch: 'Switch',
          OccupancySensor: 'OccupancySensor',
          TemperatureSensor: 'TemperatureSensor',
          HumiditySensor: 'HumiditySensor',
        },
        Characteristic: {
          Manufacturer: 'Manufacturer',
          SerialNumber: 'SerialNumber',
          Name: 'Name',
          ConfiguredName: 'ConfiguredName',
        },
        log: {
          warn: (message: string) => logs.push(message),
          error: (message: string) => logs.push(message),
          info: (message: string) => logs.push(message),
          debug: (message: string) => logs.push(message),
        },
        api: {
          updatePlatformAccessories: (accessories: FakeAccessory[]) => updatedAccessories.push(...accessories),
          // TypeScript can inline Homebridge's const enum. Keep this numeric so
          // normal compilation and type-stripped test runs exercise the same status.
          hap: { HapStatusError: FakeHapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
        },
      },
    },
    logs,
    updatedAccessories,
  };
}

async function withImmediateTimeouts<T>(fn: () => Promise<T> | T): Promise<T> {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const callbacks: Array<() => void> = [];
  global.setTimeout = (((
    callback: (...args: never[]) => void,
    _delay?: number,
    ..._args: never[]
  ) => {
    const handle = { ref() { return this; }, unref() { return this; } } as ReturnType<typeof setTimeout>;
    callbacks.push(() => callback());
    return handle;
  }) as unknown as typeof setTimeout);
  global.clearTimeout = (((_handle?: ReturnType<typeof setTimeout>) => undefined) as unknown as typeof clearTimeout);

  try {
    const result = await fn();
    while (callbacks.length > 0) {
      callbacks.shift()?.();
    }
    return result;
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

function testGetVarintSupportsLargeValues() {
  const encoded = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f]);
  const [rest, value] = __test__.getVarint(encoded);
  assert.equal(rest.length, 0);
  assert.equal(value, 34359738367);
}

function testStandbyLEDColorMessageUsesVarints() {
  const message = nightLightCommand({ enabled: true, brightness: 35, preset: 0, red: 128, green: 255, blue: 64 });
  const hex = Buffer.from(message).toString('hex');
  assert.match(hex, /208001/);
  assert.match(hex, /28ff01/);
  assert.match(hex, /3040/);
}

function testMalformedFrameIsDropped() {
  const { state, warnings } = createTestAccessoryState();
  const malformed = Buffer.from([0xc0, 0x12, 0x05, 0xc0]);

  assert.doesNotThrow(() => {
    __test__.onData(state as never, malformed);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dropped malformed protobuf frame/i);
}

function testAutoModeStateSync() {
  const { state } = createTestAccessoryState();

  __test__.fanOnState('2', state as never);
  assert.equal(state.fanStates.TargetFanState, 1);
  assert.equal(state.fanStates.Active, 0);
  assert.equal(state.fanStates.CurrentFanState, 0);

  __test__.fanRotationSpeed('3', state as never);
  assert.equal(state.fanStates.Active, 1);
  assert.equal(state.fanStates.CurrentFanState, 2);

  __test__.fanRotationSpeed('0', state as never);
  assert.equal(state.fanStates.RotationSpeed, 0);
  assert.equal(state.fanStates.Active, 0);
  assert.equal(state.fanStates.CurrentFanState, 0);
  assert.deepEqual(state.fanService.updates.at(-3), { characteristic: 'RotationSpeed', value: 0 });
}

function testRotationSpeedPercentAllowsZero() {
  assert.equal(__test__.rotationSpeedPercent(0), 0);
  assert.equal(__test__.rotationSpeedPercent(1), 14);
}

function testPercentToRotationSpeedClampsNonZeroToMinimum() {
  assert.equal(__test__.percentToRotationSpeed(0), 0);
  assert.equal(__test__.percentToRotationSpeed(1), 1);
  assert.equal(__test__.percentToRotationSpeed(5), 1);
  assert.equal(__test__.percentToRotationSpeed(43), 3);
}

async function testFanActiveDiagnosticsAreRecorded() {
  const { state, infos } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.enableDebugPort = true;

  await __test__.invokeSetFanActive(state as never, 1);

  assert.equal(state.lastFanActiveRequestValue, 1);
  assert.notEqual(state.lastFanActiveRequestAt, 0);
  assert.match(infos.at(-1) ?? '', /active diagnostics: HomeKit requested Active=1/i);
  assert.equal(socket.writes.length, 1);
  assert.match(socket.writes[0].toString('hex'), /d80201/);

  __test__.fanOnState('1', state as never);

  assert.equal(state.lastFanActiveRequestAt, 0);
  assert.equal(state.lastFanActiveRequestValue, undefined);
  assert.match(infos.at(-1) ?? '', /active diagnostics: fan reported FanOn=1 -> Active=1/i);
}

async function testFanActiveOptimisticallyUpdatesHomeKitState() {
  const { state } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.fanStates.RotationSpeed = 0;

  await __test__.invokeSetFanActive(state as never, 1);

  assert.deepEqual(state.fanService.updates.at(-2), { characteristic: 'Active', value: 1 });
  assert.deepEqual(state.fanService.updates.at(-1), { characteristic: 'CurrentFanState', value: 1 });
}

async function testDuplicateFanActiveWriteIsSuppressed() {
  const { state, infos } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.enableDebugPort = true;
  state.fanStates.RotationSpeed = 2;

  await __test__.invokeSetFanActive(state as never, 1);
  await __test__.invokeSetFanActive(state as never, 1);

  assert.equal(socket.writes.length, 1);
  assert.match(infos.at(-1) ?? '', /suppressing duplicate Active=1/i);
}

async function testRotationSpeedDiagnosticsAreRecorded() {
  const { state, infos } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.enableDebugPort = true;

  await withImmediateTimeouts(async () => {
    await __test__.invokeSetRotationSpeed(state as never, 57);
  });

  assert.equal(state.lastRotationSpeedRequestPercent, 57);
  assert.equal(state.lastRotationSpeedRequestDeviceSpeed, 4);
  assert.notEqual(state.lastRotationSpeedRequestAt, 0);
  assert.match(infos.at(-1) ?? '', /HomeKit requested 57% -> device speed 4/i);

  __test__.fanRotationSpeed('4', state as never);

  assert.equal(state.lastRotationSpeedRequestAt, 0);
  assert.match(infos.at(-1) ?? '', /fan reported 4 \(57%\)/i);
}

async function testRotationSpeedOptimisticallySnapsHomeKitState() {
  const { state } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.fanStates.Active = 0;
  state.fanStates.CurrentFanState = 0;

  await withImmediateTimeouts(async () => {
    await __test__.invokeSetRotationSpeed(state as never, 69);
  });

  assert.deepEqual(state.fanService.updates.at(-3), { characteristic: 'RotationSpeed', value: 71 });
  assert.deepEqual(state.fanService.updates.at(-2), { characteristic: 'Active', value: 1 });
  assert.deepEqual(state.fanService.updates.at(-1), { characteristic: 'CurrentFanState', value: 2 });
}

async function testRotationSpeedChangeSendsSingleWrite() {
  const { state } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.fanStates.TargetFanState = 1;
  state.fanStates.Active = 0;
  state.fanStates.CurrentFanState = 0;
  state.fanStates.RotationSpeed = 0;

  await withImmediateTimeouts(async () => {
    await __test__.invokeSetRotationSpeed(state as never, 57);
  });

  assert.equal(state.fanStates.TargetFanState, 1);
  assert.equal(socket.writes.length, 1);
  assert.match(socket.writes[0].toString('hex'), /f00204/);
}

async function testRotationSpeedIgnoresBriefStaleEchoes() {
  const { state, infos } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.enableDebugPort = true;

  await withImmediateTimeouts(async () => {
    await __test__.invokeSetRotationSpeed(state as never, 35);
  });

  __test__.fanRotationSpeed('3', state as never);
  assert.equal(state.fanStates.RotationSpeed, 2);
  assert.match(infos.at(-1) ?? '', /ignoring fan report 3/i);

  __test__.fanRotationSpeed('2', state as never);
  assert.equal(state.fanStates.RotationSpeed, 2);
  assert.equal(state.expectedRotationSpeed, undefined);
}

async function testRotationSpeedDragBurstOnlyWritesFinalSpeed() {
  const { state } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;

  const originalSetTimeout = global.setTimeout;
  let timeoutCallback: (() => void) | undefined;
  global.setTimeout = (((
    callback: (...args: never[]) => void,
    _delay?: number,
    ..._args: never[]
  ) => {
    timeoutCallback = () => callback();
    return { ref() { return this; }, unref() { return this; } } as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);

  try {
    await __test__.invokeSetRotationSpeed(state as never, 68);
    await __test__.invokeSetRotationSpeed(state as never, 43);

    assert.equal(socket.writes.length, 0);
    timeoutCallback?.();

    assert.equal(socket.writes.length, 1);
    assert.match(socket.writes[0].toString('hex'), /f00203/);
    assert.deepEqual(state.fanService.updates.at(-3), { characteristic: 'RotationSpeed', value: 43 });
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

async function testLowNonZeroRotationSpeedMapsToSpeedOne() {
  const { state } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;

  await withImmediateTimeouts(async () => {
    await __test__.invokeSetRotationSpeed(state as never, 1);
  });

  assert.equal(state.lastRotationSpeedRequestDeviceSpeed, 1);
  assert.match(socket.writes[0].toString('hex'), /f00201/);
  assert.deepEqual(state.fanService.updates.at(-3), { characteristic: 'RotationSpeed', value: 14 });
}

async function testMatchingFanReportDuringDebounceIsAccepted() {
  const { state, infos } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;
  state.enableDebugPort = true;

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timeoutCallback: (() => void) | undefined;
  global.setTimeout = (((
    callback: (...args: never[]) => void,
    _delay?: number,
    ..._args: never[]
  ) => {
    timeoutHandle = { ref() { return this; }, unref() { return this; } } as ReturnType<typeof setTimeout>;
    timeoutCallback = () => callback();
    return timeoutHandle;
  }) as unknown as typeof setTimeout);
  global.clearTimeout = (((handle?: ReturnType<typeof setTimeout>) => {
    if (handle === timeoutHandle) {
      timeoutCallback = undefined;
    }
  }) as unknown as typeof clearTimeout);

  try {
    await __test__.invokeSetRotationSpeed(state as never, 1);
    __test__.fanRotationSpeed('1', state as never);

    assert.equal(timeoutCallback, undefined);
    assert.equal(socket.writes.length, 0);
    assert.equal(state.fanStates.RotationSpeed, 1);
    assert.equal(state.lastRotationSpeedRequestAt, 0);
    assert.doesNotMatch(infos.join('\n'), /ignoring fan report 1/i);
    assert.match(infos.at(-1) ?? '', /fan reported 1 \(14%\)/i);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

async function testFanOffClearsPendingSpeedDiagnostics() {
  const { state, infos } = createTestAccessoryState();
  const socket = new FakeSocket();
  state.client = socket;

  await withImmediateTimeouts(async () => {
    await __test__.invokeSetRotationSpeed(state as never, 31);
  });

  assert.notEqual(state.lastRotationSpeedRequestAt, 0);

  __test__.fanOnState('0', state as never);

  assert.equal(state.lastRotationSpeedRequestAt, 0);
  assert.equal(state.lastRotationSpeedRequestPercent, undefined);
  assert.equal(state.lastRotationSpeedRequestDeviceSpeed, undefined);
  assert.equal(state.expectedRotationSpeed, undefined);

  __test__.fanRotationSpeed('0', state as never);
  assert.doesNotMatch(infos.at(-1) ?? '', /8161ms after HomeKit requested/i);
}

function testFanUpdatesAreNotBlockedByUnknownTargetBulb() {
  const { state } = createTestAccessoryState();
  state.capabilitiesEstablished = true;
  state.targetBulb = -1;
  state.bulbCount = 0;

  __test__.flushFunQueue(state as never, [
    [__test__.fanOnState, '1'],
    [__test__.fanRotationSpeed, '3'],
  ] as never);

  assert.equal(state.fanStates.Active, 1);
  assert.equal(state.fanStates.CurrentFanState, 2);
  assert.equal(state.fanStates.RotationSpeed, 3);
  assert.equal(state.funQueue.length, 0);
}

function testColorTemperatureCapabilityImpliesDownlight() {
  const { state, infos } = createTestAccessoryState();
  state.capabilities.hasFan = false;
  state.capabilities.hasColorTempControl = true;
  const previousCapabilities = { ...state.capabilities };

  const changed = __test__.reconcileCapabilities(state as never, previousCapabilities as never);

  assert.equal(changed, true);
  assert.equal(state.capabilities.hasLight, true);
  assert.match(infos[0], /inferring downlight presence from color temperature capability/i);
}

function testDownlightOverrideWinsOverInference() {
  const { state, infos } = createTestAccessoryState();
  state.capabilities.hasColorTempControl = true;
  state.downlightEquipped = false;
  const previousCapabilities = { ...state.capabilities };

  const changed = __test__.reconcileCapabilities(state as never, previousCapabilities as never);

  assert.equal(changed, false);
  assert.equal(state.capabilities.hasLight, false);
  assert.equal(infos.length, 0);
}

function testAutoLightOverrideNormalizesToAutodetect() {
  assert.equal(__test__.normalizeLightDetectionOverride('auto'), undefined);
  assert.equal(__test__.normalizeLightDetectionOverride(true), true);
  assert.equal(__test__.normalizeLightDetectionOverride(false), false);
  assert.equal(__test__.normalizeLightDetectionOverride(undefined), undefined);
}

function protobufVarintField(field: number, value: number) {
  return Buffer.from([
    ...__test__.varint_encode((field << 3) | 0),
    ...__test__.varint_encode(value),
  ]);
}

function protobufMessageField(field: number, body: Buffer) {
  return Buffer.from([
    ...__test__.varint_encode((field << 3) | 2),
    ...__test__.varint_encode(body.length),
    ...body,
  ]);
}

function testCapabilityParserExtractsLiveCapabilities() {
  const capabilityMessage = Buffer.concat([
    protobufVarintField(6, 1),
    protobufVarintField(7, 1),
    protobufVarintField(14, 1),
  ]);
  const payload = protobufMessageField(2,
    protobufMessageField(4,
      protobufMessageField(2,
        protobufMessageField(17, capabilityMessage),
      ),
    ),
  );
  const data = Buffer.concat([Buffer.from([0xc0]), payload, Buffer.from([0xc0])]);

  const capabilities = parseCapabilitiesFromSlipData(data);

  assert.equal(capabilities?.hasFan, true);
  assert.equal(capabilities?.hasColorTempControl, true);
  assert.equal(capabilities?.hasEcoMode, true);
  assert.equal(capabilities?.hasLight, false);

  const summary = summarizeCapabilityExposure(capabilities!, {
    showEcoModeSwitch: false,
    showHumidity: true,
    showTemperature: true,
  });

  assert.deepEqual(summary.detected, ['fan', 'downlight', 'eco mode']);
  assert.deepEqual(summary.exposed, ['fan', 'downlight']);
  assert.deepEqual(summary.hiddenByConfig, ['eco mode']);
  assert.deepEqual(summary.notReportedButEnabled, ['temperature', 'humidity']);
}

function testMacDiscoveryReadsOnlyFanIdentity() {
  const frame = (properties: Buffer) => Buffer.concat([
    Buffer.from([0xc0]),
    Buffer.from([...protobufMessageField(2, protobufMessageField(4, protobufMessageField(2, properties)))]
      .flatMap(byte => byte === 0xc0 ? [0xdb, 0xdc] : byte === 0xdb ? [0xdb, 0xdd] : [byte])),
    Buffer.from([0xc0]),
  ]);
  const remote = protobufMessageField(152, protobufMessageField(4, Buffer.from('11:22:33:44:55:66')));
  assert.equal(parseMacFromSlipData(frame(remote)), undefined);
  for (const mac of ['aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'aabbccddeeff']) {
    const bytes = frame(Buffer.concat([remote, protobufMessageField(8, Buffer.from(mac))]));
    assert.equal(parseMacFromSlipData(bytes.subarray(0, bytes.length - 1)), undefined);
    assert.equal(parseMacFromSlipData(bytes), 'AA:BB:CC:DD:EE:FF');
  }
  for (const mac of ['not-a-mac', '00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF']) {
    assert.equal(parseMacFromSlipData(frame(protobufMessageField(8, Buffer.from(mac)))), undefined);
  }
  const valid = frame(protobufMessageField(8, Buffer.from('AA:BB:CC:DD:EE:FF')));
  assert.equal(parseMacFromSlipData(Buffer.concat([frame(remote), valid])), 'AA:BB:CC:DD:EE:FF');
}

function testCapabilitySuggestionsOnlyHideUnsupportedOptions() {
  const suggestions = suggestCapabilityConfig({
    hasTempSensor: false,
    hasHumiditySensor: false,
    hasOccupancySensor: false,
    hasLight: true,
    hasLightSensor: false,
    hasColorTempControl: true,
    hasFan: true,
    hasSpeaker: false,
    hasPiezo: false,
    hasLEDIndicators: false,
    hasUplight: false,
    hasUVCLight: false,
    hasStandbyLED: false,
    hasEcoMode: false,
  }, {
    showTemperature: true,
    showHumidity: true,
    showFanOccupancySensor: true,
    showEcoModeSwitch: true,
    noLights: true,
  });

  assert.deepEqual(suggestions.map((suggestion) => suggestion.key), [
    'showTemperature',
    'showHumidity',
    'showFanOccupancySensor',
    'showEcoModeSwitch',
  ]);
  assert.deepEqual(suggestions.map((suggestion) => suggestion.value), [false, false, false, false]);
  assert.equal(suggestions.some((suggestion) => suggestion.key === 'noLights'), false);
}

function testUnsupportedCapabilityServicesAreRemovedFromCache() {
  const { accessory, state, updatedAccessories } = createTestServiceState();

  __test__.makeServices(state as never);

  assert.equal(accessory.hasService('occupancySensor-1'), false);
  assert.equal(accessory.hasService('occupancySensor-2'), false);
  assert.equal(accessory.hasService('TemperatureSensor'), false);
  assert.equal(accessory.hasService('HumiditySensor'), false);
  assert.equal(accessory.hasService('switch-6'), false);
  assert.equal(accessory.hasService('switch-5'), false);
  assert.equal(accessory.hasService('light-2'), false);
  assert.equal(updatedAccessories.includes(accessory), true);
}

async function testReconnectOnClose() {
  const { state } = createTestAccessoryState();
  const originalSetTimeout = global.setTimeout;
  const sockets: FakeSocket[] = [];
  const pendingConnectListeners: Array<() => void> = [];

  try {
    __test__.setConnectSocketForTest(((_: net.NetConnectOpts, listener?: () => void) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      if (listener) {
        pendingConnectListeners.push(listener);
      }
      return socket as unknown as net.Socket;
    }) as typeof net.connect);

    global.setTimeout = (((
      callback: (...args: never[]) => void,
      _delay?: number,
      ..._args: never[]
    ) => {
      callback();
      return { ref() { return this; }, unref() { return this; } } as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    __test__.networkSetup(state as never);
    pendingConnectListeners.shift()?.();
    assert.equal(sockets.length, 1);

    sockets[0].emit('close');
    pendingConnectListeners.shift()?.();

    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].destroyed, true);
    assert.equal(state.client, sockets[1]);
  } finally {
    __test__.resetConnectSocketForTest();
    global.setTimeout = originalSetTimeout;
  }
}

async function testProbeRequestsStateRefresh() {
  const { state } = createTestAccessoryState();
  state.ProbeFrequency = 60000;

  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const sockets: FakeSocket[] = [];
  const pendingConnectListeners: Array<() => void> = [];
  let intervalCallback: (() => void) | undefined;

  try {
    __test__.setConnectSocketForTest(((_: net.NetConnectOpts, listener?: () => void) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      if (listener) {
        pendingConnectListeners.push(listener);
      }
      return socket as unknown as net.Socket;
    }) as typeof net.connect);

    global.setTimeout = (((
      callback: (...args: never[]) => void,
      _delay?: number,
      ..._args: never[]
    ) => {
      callback();
      return { ref() { return this; }, unref() { return this; } } as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    global.setInterval = (((
      callback: (...args: never[]) => void,
      _delay?: number,
      ..._args: never[]
    ) => {
      intervalCallback = () => callback();
      return { ref() { return this; }, unref() { return this; } } as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    __test__.networkSetup(state as never);
    pendingConnectListeners.shift()?.();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].writes.length, 2);

    intervalCallback?.();

    assert.equal(sockets[0].writes.length, 4);
  } finally {
    __test__.resetConnectSocketForTest();
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
  }
}


function createDualLightTestState() {
  const fixture = createTestServiceState();
  const state = Object.assign(Object.create(BigAssFans_i6PlatformAccessory.prototype), fixture.state, {
    client: new FakeSocket(),
    chunkFragment: Buffer.alloc(0),
    funQueue: [],
    whiteLightReport: {},
    lightModeServices: new Map(),
    dualLightModeControl: 'exclusive',
    capabilitiesEstablished: true,
    showEcoModeSwitch: false,
    showStandbyLED: true,
    targetBulb: -1,
    downlightStates: { On: false, Brightness: 1 },
    uplightStates: { On: false, Brightness: 1 },
    standbyLEDStates: { On: false, Brightness: 0, Hue: 0, Saturation: 0 },
  }) as BigAssFans_i6PlatformAccessory;
  state.capabilities.hasLight = true;
  state.capabilities.hasUplight = true;
  state.capabilities.hasColorTempControl = true;
  state.capabilities.hasStandbyLED = true;
  Object.assign(state.platform.Characteristic, {
    On: 'On', Brightness: 'Brightness', ColorTemperature: 'ColorTemperature', Hue: 'Hue', Saturation: 'Saturation',
  });
  return { ...fixture, state };
}

function reportFrame(fields: Array<[number, number]>) {
  const properties = fields.flatMap(([field, value]) => {
    const property = [...__test__.varint_encode(field * 8), ...__test__.varint_encode(value)];
    return [0x12, ...__test__.varint_encode(property.length), ...property];
  });
  const update = [0x22, ...__test__.varint_encode(properties.length), ...properties];
  const root = [0x12, ...__test__.varint_encode(update.length), ...update];
  const escaped = root.flatMap(byte => byte === 0xc0 ? [0xdb, 0xdc] : byte === 0xdb ? [0xdb, 0xdd] : [byte]);
  return Buffer.from([0xc0, ...escaped, 0xc0]);
}

function testCoordinatedServiceLifecycleAndFragmentedReports() {
  const { state, accessory } = createDualLightTestState();
  __test__.makeServices(state);
  assert.ok(accessory.getServiceById('Lightbulb', 'white-light'));
  assert.equal(accessory.getServiceById('Lightbulb', 'light-1'), undefined);
  assert.equal(accessory.getServiceById('Lightbulb', 'light-2'), undefined);
  assert.equal(state.lightModeServices.size, 3);
  assert.ok(accessory.getServiceById('Lightbulb', 'light-3'));
  assert.equal(accessory.getServiceById('Switch', 'switch-7'), undefined);

  // Mode intentionally appears after brightness in the same update.
  const frame = reportFrame([[69, 67], [68, 1], [82, 0], [71, 3008], [78, 2700], [79, 4000]]);
  for (const byte of frame) {
    __test__.onData(state, Buffer.from([byte]));
  }
  assert.equal(state.whiteLight?.ready, true);
  assert.equal(state.whiteLight?.state.selection, 0);
  assert.equal(state.whiteLight?.memory.down, 67);
  assert.equal(accessory.getServiceById('Lightbulb', 'white-light')?.values.get('Brightness'), 67);
  assert.equal(accessory.context.whiteLightMemory?.down, 67);

  __test__.onData(state, Buffer.concat([
    reportFrame([[82, 2], [69, 80], [68, 1]]),
    reportFrame([[82, 1], [69, 25], [68, 1]]),
  ]));
  assert.deepEqual(state.whiteLight?.memory, { down: 25, up: 80 });
  state.dualLightModeControl = 'channels';
  __test__.makeServices(state);
  assert.equal(state.lightModeServices.size, 2);
  assert.equal(accessory.getServiceById('Switch', 'white-mode-0'), undefined);

  state.noLights = true;
  __test__.makeServices(state);
  assert.equal(state.whiteLight, undefined);
  assert.equal(accessory.getServiceById('Lightbulb', 'white-light'), undefined);
  assert.equal(accessory.getServiceById('Lightbulb', 'light-3'), undefined);
}

function testUplightOnlyIsNotMistakenForDualLight() {
  const { state, accessory } = createDualLightTestState();
  state.capabilities.hasLight = false;
  state.capabilities.hasStandbyLED = false;
  __test__.reconcileCapabilities(state, { ...state.capabilities });
  assert.equal(state.capabilities.hasLight, false);
  __test__.makeServices(state);
  assert.equal(state.whiteLight, undefined);
  assert.equal(accessory.getServiceById('Lightbulb', 'white-light'), undefined);
  assert.ok(accessory.getServiceById('Lightbulb', 'light-2'));
  assert.equal(accessory.getServiceById('Lightbulb', 'light-3'), undefined);
}

async function testExternalLightReportWinsDuringHomeKitWrite() {
  const { state, accessory } = createDualLightTestState();
  __test__.makeServices(state);
  __test__.onData(state, reportFrame([[82, 1], [68, 1], [69, 25]]));
  const change = state.whiteLight!.setBrightness(60);
  state.whiteLight!.flush();
  await change;
  const socket = state.client as unknown as FakeSocket;
  const writes = socket.writes.length;
  __test__.onData(state, reportFrame([[69, 35]]));
  assert.equal(accessory.getServiceById('Lightbulb', 'white-light')?.values.get('Brightness'), 35);
  assert.equal(accessory.context.whiteLightMemory?.down, 35);
  assert.equal(socket.writes.length, writes, 'Reflecting a BAF change must not send it back to the fan');
  __test__.sendLightStateRefreshRequest(state);
  assert.deepEqual(socket.writes.at(-1), Buffer.from([0xc0, 0x12, 0x04, 0x1a, 0x02, 0x08, 0x02, 0xc0]));
  state.whiteLight!.disconnect();
}

async function testHomeKitAckDoesNotTurnZeroBrightnessBackOn() {
  const { state, accessory } = createDualLightTestState();
  __test__.makeServices(state);
  __test__.onData(state, reportFrame([[82, 1], [68, 1], [69, 25]]));
  const service = accessory.getServiceById('Lightbulb', 'white-light')!;
  const on = Promise.resolve(service.setters.get('On')!(true)).then(() => service.updateCharacteristic('On', true));
  const brightness = Promise.resolve(service.setters.get('Brightness')!(0)).then(() => service.updateCharacteristic('Brightness', 0));
  state.whiteLight!.flush();
  await Promise.all([on, brightness]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.values.get('On'), false);
  state.whiteLight!.disconnect();
}

function testStandbyMessageEnvelope() {
  const message = Buffer.from(nightLightCommand({ enabled: true, brightness: 35, preset: 0, red: 128, green: 255, blue: 64 }));
  // ApiMessage -> Job -> repeated Property -> StandbyLed. There must be no protobuf group delimiters.
  let bytes: Buffer = message;
  for (const expectedKey of [0x12, 0x12, 0x1a, 0x29a]) {
    let key: number;
    let length: number;
    [bytes, key] = __test__.getVarint(bytes);
    assert.equal(key, expectedKey);
    [bytes, length] = __test__.getVarint(bytes);
    assert.equal(bytes.length, length);
  }
  assert.equal(message[0], 0x12);
}

/** Decode the actual socket write and require a complete six-field StandbyLed. */
function decodeNightLightWrite(frame: Buffer) {
  assert.equal(frame[0], 0xc0);
  assert.equal(frame.at(-1), 0xc0);
  let bytes = __test__.unstuff(frame.subarray(1, -1));
  for (const expectedKey of [0x12, 0x12, 0x1a, 0x29a]) {
    let key: number;
    let length: number;
    [bytes, key] = __test__.getVarint(bytes);
    assert.equal(key, expectedKey);
    [bytes, length] = __test__.getVarint(bytes);
    assert.equal(bytes.length, length);
  }
  const fields: Record<number, number> = {};
  while (bytes.length) {
    let key: number;
    let value: number;
    [bytes, key] = __test__.getVarint(bytes);
    [bytes, value] = __test__.getVarint(bytes);
    assert.equal(key & 7, 0);
    fields[key >> 3] = value;
  }
  assert.deepEqual(Object.keys(fields), ['1', '2', '3', '4', '5', '6']);
  return fields;
}

function nightLightReportFrame(fields: Array<[number, number]>) {
  const inner = fields.flatMap(([field, value]) => [...__test__.varint_encode(field * 8), ...__test__.varint_encode(value)]);
  const property = [0x9a, 0x05, ...__test__.varint_encode(inner.length), ...inner];
  const properties = [0x12, ...__test__.varint_encode(property.length), ...property];
  const update = [0x22, ...__test__.varint_encode(properties.length), ...properties];
  const root = [0x12, ...__test__.varint_encode(update.length), ...update];
  const escaped = root.flatMap(byte => byte === 0xc0 ? [0xdb, 0xdc] : byte === 0xdb ? [0xdb, 0xdd] : [byte]);
  return Buffer.from([0xc0, ...escaped, 0xc0]);
}

async function testNightLightControlsPreserveEnableAndIntensity() {
  const { state, accessory } = createDualLightTestState();
  __test__.makeServices(state);
  // BAF enables the red night light at 35%; zero channels are omitted in the report.
  __test__.onData(state, nightLightReportFrame([[1, 1], [2, 1], [3, 35]]));
  const light = state.nightLight!;
  const socket = state.client as unknown as FakeSocket;
  const service = accessory.getServiceById('Lightbulb', 'light-3')!;
  assert.equal(service.values.get('On'), true);
  const writesBeforeColor = socket.writes.length;
  const hue = state.setStandbyLEDHue(240);
  const saturation = state.setStandbyLEDSaturation(100);
  light.flush();
  await Promise.all([hue, saturation]);
  assert.equal(socket.writes.length, writesBeforeColor + 1, 'Hue and saturation should share one command');
  assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 0, 2: 1, 3: 35, 4: 0, 5: 0, 6: 255 });

  const intensity = state.setStandbyLEDBrightness(60);
  light.flush();
  await intensity;
  assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 0, 2: 1, 3: 60, 4: 0, 5: 0, 6: 255 });
  __test__.onData(state, nightLightReportFrame([[2, 1], [3, 60], [6, 255]]));
  assert.equal(accessory.context.nightLightBrightness, 60);

  const off = state.setStandbyLEDOnState(false);
  light.flush();
  await off;
  assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 0, 2: 0, 3: 60, 4: 0, 5: 0, 6: 255 });
  // A disabled report can omit enabled and intensity; both must reset to zero.
  __test__.onData(state, nightLightReportFrame([[6, 255]]));
  assert.equal(service.values.get('On'), false);
  assert.equal(light.state.brightness, 0);
  const on = state.setStandbyLEDOnState(true);
  light.flush();
  await on;
  assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 0, 2: 1, 3: 60, 4: 0, 5: 0, 6: 255 });

  // The BAF app changes its preset/enable while a HomeKit command awaits feedback.
  const writes = socket.writes.length;
  __test__.onData(state, nightLightReportFrame([[1, 2], [3, 20]]));
  assert.equal(service.values.get('On'), false);
  assert.equal(service.values.get('Brightness'), 20);
  assert.equal(service.values.get('Hue'), 106);
  assert.equal(socket.writes.length, writes, 'A BAF report must not cause an outgoing command');
  const nextOn = state.setStandbyLEDOnState(true);
  light.flush();
  await nextOn;
  assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 2, 2: 1, 3: 20, 4: 0, 5: 0, 6: 0 });
  const scene = [state.setStandbyLEDOnState(false), state.setStandbyLEDBrightness(15),
    state.setStandbyLEDHue(0), state.setStandbyLEDSaturation(50)];
  light.flush();
  await Promise.all(scene);
  assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 0, 2: 0, 3: 15, 4: 255, 5: 128, 6: 128 });
  const colorWhileOff = state.setStandbyLEDHue(120);
  light.flush();
  await colorWhileOff;
  assert.equal(decodeNightLightWrite(socket.writes.at(-1)!)[2], 0, 'Color alone must not override Off');
  light.disconnect();
  state.whiteLight!.disconnect();
}

async function testNightLightInitialEnableAndZeroIntensityScene() {
  for (const zeroFirst of [false, true]) {
    const { state, accessory } = createDualLightTestState();
    __test__.makeServices(state);
    const light = state.nightLight!;
    const socket = state.client as unknown as FakeSocket;
    await assert.rejects(state.setStandbyLEDOnState(true), (error: unknown) =>
      error instanceof FakeHapStatusError && error.hapStatus === -70402);
    // Empty StandbyLed is disabled, zero intensity and custom black.
    __test__.onData(state, nightLightReportFrame([]));
    const on = state.setStandbyLEDOnState(true);
    light.flush();
    await on;
    assert.deepEqual(decodeNightLightWrite(socket.writes.at(-1)!), { 1: 7, 2: 1, 3: 25, 4: 255, 5: 255, 6: 255 });
    assert.equal(accessory.context.nightLightBrightness, undefined, 'Do not persist unconfirmed fallback intensity');
    const service = accessory.getServiceById('Lightbulb', 'light-3')!;
    const writes = socket.writes.length;
    const changes: Array<[string, boolean | number]> = [['On', true], ['Brightness', 0]];
    if (zeroFirst) {
      changes.reverse();
    }
    const pending = changes.map(([key, value]) => Promise.resolve(service.setters.get(key)!(value))
      .then(() => service.updateCharacteristic(key, value)));
    light.flush();
    await Promise.all(pending);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(socket.writes.length, writes + 1);
    const command = decodeNightLightWrite(socket.writes.at(-1)!);
    assert.equal(command[2], 0);
    assert.equal(command[3], 0);
    assert.equal(service.values.get('On'), false, 'HAP acknowledgements must not undo the coordinated Off');
    light.disconnect();
    state.whiteLight!.disconnect();
  }
}

async function testNightLightFeedbackTimeoutAndDisconnect() {
  const commands: NightLightState[] = [];
  const warnings: string[] = [];
  let queries = 0;
  let fail = false;
  const light = new NightLightCoordinator(45, state => {
    if (fail) {
      throw new Error('Socket failed');
    }
    commands.push(state);
  }, () => { queries++; }, () => undefined, message => warnings.push(message));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    light.report({ ...emptyNightLightState(), preset: 3 });
    const firstOn = light.setPower(true);
    light.flush();
    await firstOn;
    assert.equal(commands[0].brightness, 45, 'Restore confirmed brightness saved before a restart');
    light.report({ ...light.state, brightness: 30 });
    mock.timers.tick(3000);
    assert.equal(queries, 0, 'A fan report cancels readback and timeout');
    assert.equal(warnings.length, 0);

    const brightness = light.setBrightness(70);
    light.flush();
    await brightness;
    mock.timers.tick(250);
    assert.equal(queries, 1);
    mock.timers.tick(2250);
    assert.equal(warnings.length, 1);
    assert.equal(light.state.brightness, 30);
    assert.equal(light.rememberedBrightness, 30);
    assert.equal(commands.length, 2, 'Timeout must not retry a previous command');

    fail = true;
    const failed = assert.rejects(light.setPower(false), /Socket failed/);
    light.flush();
    await failed;
    assert.equal(light.state.enabled, true, 'A failed socket write must not change cached state');
    const disconnected = assert.rejects(light.setBrightness(90), /disconnected/);
    light.disconnect();
    await disconnected;
    mock.timers.tick(3000);
    assert.equal(commands.length, 2);
    assert.equal(queries, 1);
    await assert.rejects(light.setPower(true), /Waiting for the fan/);
  } finally {
    light.disconnect();
    mock.timers.reset();
  }
}

async function main() {
  testMacDiscoveryReadsOnlyFanIdentity();
  await testNightLightControlsPreserveEnableAndIntensity();
  await testNightLightInitialEnableAndZeroIntensityScene();
  await testNightLightFeedbackTimeoutAndDisconnect();
  await testExternalLightReportWinsDuringHomeKitWrite();
  await testHomeKitAckDoesNotTurnZeroBrightnessBackOn();
  testCoordinatedServiceLifecycleAndFragmentedReports();
  testUplightOnlyIsNotMistakenForDualLight();
  testStandbyMessageEnvelope();
  testGetVarintSupportsLargeValues();
  testStandbyLEDColorMessageUsesVarints();
  testMalformedFrameIsDropped();
  testAutoModeStateSync();
  testRotationSpeedPercentAllowsZero();
  testPercentToRotationSpeedClampsNonZeroToMinimum();
  await testFanActiveDiagnosticsAreRecorded();
  await testFanActiveOptimisticallyUpdatesHomeKitState();
  await testDuplicateFanActiveWriteIsSuppressed();
  await testRotationSpeedDiagnosticsAreRecorded();
  await testRotationSpeedOptimisticallySnapsHomeKitState();
  await testRotationSpeedChangeSendsSingleWrite();
  await testRotationSpeedIgnoresBriefStaleEchoes();
  await testRotationSpeedDragBurstOnlyWritesFinalSpeed();
  await testLowNonZeroRotationSpeedMapsToSpeedOne();
  await testMatchingFanReportDuringDebounceIsAccepted();
  await testFanOffClearsPendingSpeedDiagnostics();
  testFanUpdatesAreNotBlockedByUnknownTargetBulb();
  testColorTemperatureCapabilityImpliesDownlight();
  testDownlightOverrideWinsOverInference();
  testAutoLightOverrideNormalizesToAutodetect();
  testCapabilityParserExtractsLiveCapabilities();
  testCapabilitySuggestionsOnlyHideUnsupportedOptions();
  testUnsupportedCapabilityServicesAreRemovedFromCache();
  await testReconnectOnClose();
  await testProbeRequestsStateRefresh();
  console.log('Regression tests passed.');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

