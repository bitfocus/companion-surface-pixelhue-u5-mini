# Pixelhue U5 Mini

Companion is primarily intended to be used with the **Pixelhue U5 Mini** control surface.

This module connects to the U5 Mini over TCP, maps physical keys to Companion's button grid, displays button images on the device, and receives key press and release events.

## Supported Device

We currently support the following model:

- **Pixelhue U5 Mini**

The U5 Mini connects over the network (TCP), not USB. It must be added under **Remote Surfaces** in Companion.

## Layout

The U5 Mini presents as a **10×4** button grid (40 keys total).

## Installation

Before you can add a U5 Mini, install and enable this surface module in Companion:

1. Open the Companion web UI.
2. In the left sidebar, go to **Surfaces**.
3. Click **Add Surface Integration** , and add the `Pixelhue U5 Mini`.

## Adding a U5 Mini in Companion

1. Open the Companion web UI.
2. In the left sidebar, click **Surfaces**.
3. Open the **Remote Surfaces** tab.

### Discover Surfaces

Discovery automatically finds all U5 Mini devices on your local network.

On the **Remote Surfaces** page, discovered devices appear in the **Discover Surfaces** panel on the right. Click a discovered U5 Mini to add it directly.

### Remote Surfaces (manual)

To add a device manually, use the **Remote Surfaces** panel on the left and create a new remote surface connection. Select the **pixelhue-u5-mini** module and fill in the fields below:

| Field          | Description            |
| -------------- | ---------------------- |
| **Name**       | Device name            |
| **IP Address** | Device IP address      |
| **Port**       | Default value: `17100` |

## Notes

The U5 Mini can have only one Companion connection at a time. The connection established later takes precedence, and the previous connection is automatically disconnected.
