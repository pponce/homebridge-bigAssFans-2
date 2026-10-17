import assert from 'node:assert/strict';
import { DualLightCoordinator, lightCommand, rgbToHueSaturation, type LightCommand, type WhiteLightState } from '../src/lighting';

function harness(memory = { down: 25, up: 75 }) {
  const commands: LightCommand[][] = [];
  const warnings: string[] = [];
  let fail = false;
  const light = new DualLightCoordinator(memory, batch => {
    if (fail) {
      throw new Error('Disconnected');
    }
    commands.push(batch);
  }, () => undefined, () => undefined, message => warnings.push(message));
  light.report({ selection: 1, power: 1, brightness: 25, kelvin: 3000, minKelvin: 2700, maxKelvin: 4000 });
  return { light, commands, warnings, fail: () => { fail = true; } };
}

async function apply(light: DualLightCoordinator, changes: Promise<void>[], actual?: Partial<WhiteLightState>) {
  light.flush();
  await Promise.all(changes);
  light.report({ ...light.view, ...actual });
}

async function main() {
  const { light, commands } = harness();
  await apply(light, [light.select(2, true)]);
  assert.equal(light.state.brightness, 75);
  assert.deepEqual(commands.at(-1), [{ field: 82, value: 2 }, { field: 69, value: 75 }, { field: 68, value: 1 }]);
  await apply(light, [light.setBrightness(60)]);
  await apply(light, [light.select(1, true)]);
  assert.equal(light.state.brightness, 25);
  await apply(light, [light.select(0, true)]);
  assert.equal(light.state.brightness, 25);
  await apply(light, [light.setBrightness(45)]);
  assert.deepEqual(light.memory, { down: 45, up: 60 });
  await apply(light, [light.select(2, true)]);
  assert.equal(light.state.brightness, 60);
  await apply(light, [light.select(0, true)]);
  assert.equal(light.state.brightness, 45);

  // The original issue: Both 67%, turning Up off must select Down and keep the light on.
  light.report({ selection: 0, power: 1, brightness: 67 });
  await apply(light, [light.setChannel(2, false)]);
  assert.equal(light.state.selection, 1);
  assert.equal(light.state.power, 1);
  assert.equal(light.state.brightness, 67);
  assert.equal(light.channelOn(1), true);
  assert.equal(light.channelOn(2), false);
  await apply(light, [light.setChannel(1, false)]);
  assert.equal(light.state.power, 0);
  assert.equal(light.channelOn(1), false);
  await apply(light, [light.setChannel(2, true)]);
  assert.equal(light.state.brightness, 60);
  await apply(light, [light.setChannel(1, true)]);
  assert.equal(light.state.selection, 0);
  assert.equal(light.state.brightness, 67);

  // Scene order must not reset an explicit brightness when the mode arrives later.
  await apply(light, [light.setBrightness(33), light.select(2, true)]);
  assert.equal(light.state.brightness, 33);
  await apply(light, [light.select(1, true), light.setBrightness(44)]);
  assert.equal(light.state.brightness, 44);
  await apply(light, [light.select(1, false)]);
  assert.equal(light.state.selection, 1);
  await apply(light, [light.setPower(false)]);
  assert.equal(light.state.selection, 1);
  assert.equal(light.state.power, 0);
  await apply(light, [light.setPower(true)]);
  assert.equal(light.state.brightness, 44);

  // App/remote snapshots replace HomeKit state; a selector-only report must not overwrite brightness memory.
  light.report({ selection: 2 });
  assert.equal(light.memory.up, 33);
  light.report({ brightness: 80, power: 1 });
  assert.equal(light.state.selection, 2);
  assert.equal(light.memory.up, 80);
  light.report({ selection: 1, brightness: 22, power: 1 });
  assert.equal(light.memory.down, 22);
  await apply(light, [light.setBrightness(0)], { brightness: 22, power: 0 });
  assert.equal(light.memory.down, 22);
  await apply(light, [light.setPower(true)]);
  assert.equal(light.state.brightness, 22);

  // General HomeKit temperature, bounds, firmware rounding, and correct Kelvin protobuf encoding.
  await apply(light, [light.setTemperature(286)], { kelvin: 3500 });
  assert.equal(light.state.kelvin, 3500);
  assert.equal(commands.at(-1)?.[0].value, Math.round(1000000 / 286));
  await apply(light, [light.setTemperature(100)]);
  assert.equal(light.state.kelvin, 4000);
  assert.deepEqual(lightCommand(82, 2), [0x12, 7, 0x12, 5, 0x1a, 3, 0x90, 5, 2]);
  assert.deepEqual(lightCommand(71, 3000), [0x12, 8, 0x12, 6, 0x1a, 4, 0xb8, 4, 0xb8, 0x17]);
  assert.deepEqual(rgbToHueSaturation(255, 0, 0), [0, 100]);
  assert.deepEqual(rgbToHueSaturation(0, 255, 0), [120, 100]);
  assert.deepEqual(rgbToHueSaturation(0, 0, 255), [240, 100]);

  // Memory persists per accessory; a restart waits for actual state before accepting commands.
  const saved = { ...light.persistedMemory };
  light.disconnect();
  const restored = new DualLightCoordinator(saved, () => undefined, () => undefined, () => undefined, () => undefined);
  assert.deepEqual(restored.memory, saved);
  await assert.rejects(restored.select(2, true), /Waiting/);
  restored.report({ selection: 1, power: 0, brightness: saved.down! });
  await apply(restored, [restored.select(2, true)]);
  assert.equal(restored.state.brightness, saved.up);
  restored.disconnect();

  // Writes fail without optimistic memory changes; disconnect cancels queued writes.
  const failure = harness();
  failure.fail();
  const rejected = assert.rejects(failure.light.select(2, true), /Disconnected/);
  failure.light.flush();
  await rejected;
  assert.equal(failure.light.state.selection, 1);
  assert.deepEqual(failure.light.persistedMemory, { down: 25, up: 75 });
  const cancelled = assert.rejects(failure.light.select(2, true), /disconnected/);
  failure.light.disconnect();
  await cancelled;

  // Stale in-flight echoes do not overwrite the requested mode or the other brightness memory.
  const stale = harness();
  const change = stale.light.select(2, true);
  stale.light.flush();
  await change;
  assert.deepEqual(stale.light.persistedMemory, { down: 25, up: 75 });
  stale.light.report({ selection: 1, power: 1, brightness: 25 });
  assert.equal(stale.light.state.selection, 2);
  stale.light.report({ selection: 2, power: 1, brightness: 73 });
  assert.equal(stale.light.state.brightness, 73);
  assert.deepEqual(stale.light.memory, { down: 25, up: 73 });
  stale.light.disconnect();

  console.log('Coordinated lighting tests passed.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
