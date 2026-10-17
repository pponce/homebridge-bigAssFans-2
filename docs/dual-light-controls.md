# Dual-light controls

Fans that report both a downlight and an uplight get one **White Light** tile with power, brightness and (when supported) color temperature.

Choose **Dual-light mode controls** in the plugin settings:

- **Down / Up / Both — one selected** (`exclusive`, default): selecting a mode turns the white light on. Turning the selected mode switch off leaves it selected; use White Light to turn the light off. The selected mode remains visible while the light is off.
- **Down + Up — combine switches** (`channels`): Down on / Up off selects Down; Up on / Down off selects Up; both on selects Both; both off turns the white light off. Turning White Light back on restores the last selected mode.
- **Legacy separate dimmers** (`legacy`): retain the old layout.

Down and Up remember separate brightness levels. Entering Both restores Down's remembered level. Dimming in Both changes the shared output and Down's memory, leaving Up's memory alone. Memory is kept per accessory in Homebridge's cache and survives restarts. Until an individual mode has been used, it inherits the current level. Removing the accessory/cache also removes its brightness memory.

Changes made in the BAF app or with the remote are authoritative. Their reported brightness updates the memory for the reported mode. The plugin applies its restore rule when changing modes from HomeKit; it does not fight changes made by other controllers.

## White temperature

HomeKit's white-temperature picker sends a Kelvin value through the local API, without restricting it to the four BAF app presets. The fan's reported minimum and maximum temperatures set the available range. Until those bounds arrive, the plugin uses a conservative 2700–4000 K range, expanded to include an already reported current temperature.

If firmware rounds a request to a supported value, the returned value is shown in HomeKit. API support for a numeric value does not establish the physical resolution of the LEDs. Dim to Warm can also change the reported temperature as brightness changes.

## Supported features

Capability detection uses the fan's local DeviceCapabilities report. The combined layout requires both white lights. A color-temperature capability by itself is not taken as evidence of a downlight when an uplight is present. Existing light-presence overrides remain available for firmware with incorrect reports.

Night-light controls require `hasStandbyLED` and the **Show standby LED controls** option. On the combined layout, the color tile replaces the redundant enable switch. Its On state means the night-light feature is enabled; firmware decides when the standby light actually illuminates. Color, brightness and enable changes from the app are reflected in HomeKit.

Temperature, humidity, occupancy and Eco services remain gated by their capability flags. Whoosh and Fan Auto can have named switches alongside native fan controls. Dim to Warm requires a color-temperature-capable light. Use **Test Connection** to inspect reported capabilities.

Example additional fields in an existing fan entry:

```json
{
  "dualLightModeControl": "exclusive",
  "showWhooshSwitch": true,
  "showFanAutoSwitch": true,
  "showLightAutoSwitch": true,
  "showDimToWarmSwitch": true,
  "showEcoModeSwitch": true,
  "showStandbyLED": true,
  "showTemperature": true,
  "showHumidity": true,
  "showFanOccupancySensor": true,
  "showLightOccupancySensor": true
}
```

Single-light and unlit fans retain their existing white-light layout. Hidden lights do not expose night-light controls. Switching layouts removes the replaced services; HomeKit scenes targeting an old light tile may need to be updated.

## Device validation

Automated tests cannot establish undocumented firmware behavior. Check these on the actual fan before installing this branch as the normal build:

1. Set Down to 25%, Up to 75%, then alternate modes. Each should return to its own level.
2. Enter Both from Up. Expect 25% on both emitters. Set Both to 45%, then check Down is 45% and Up is still 75%.
3. In the two-switch layout, start at Both 67% and turn Up off. Down must remain lit at 67%.
4. Turn both switches off, then select each combination. Confirm the main tile and physical light agree.
5. Change modes and brightness through the remote and BAF app; check all HomeKit switches update together.
6. Run a scene that selects a mode and brightness together. Repeat with a different mode/level.
7. Move HomeKit's white-temperature picker between the app's presets. Inspect the returned value and whether the hardware rounds it.
8. Enable the night light, change its color in both apps, and confirm standby behavior when white lighting is on/off.
9. Restart Homebridge and confirm memory survives. Disconnect the fan and confirm commands fail, then recover after reconnection.
10. Check another fan with one light and a device without a night light: neither should gain unsupported tiles.
