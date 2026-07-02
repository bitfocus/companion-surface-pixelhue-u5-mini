import { MiniDiscoveryService, MiniConnectionManager } from '@pixelhue/event-controller-sdk'
import type { DiscoveredRemoteSurfaceInfo, RemoteSurfaceConnectionInfo } from '@companion-surface/base'
import { createModuleLogger } from '@companion-surface/base'
import { PNG } from 'pngjs'
import {
	BUTTON_HEIGHT,
	BUTTON_WIDTH,
	DEFAULT_TCP_PORT,
	MAX_DRAW_QUEUE_LENGTH,
	IPV4_REGEX,
	PIXELHUE_U5_MINI_NAME,
	CONNECTED_POLL_DELAY_MS,
	CONNECT_WAIT_TIMEOUT_MS,
} from './constants.js'
import { DEFAULT_SURFACE_LAYOUT } from './layout.js'
import type { DeviceInfoT, DrawItem, HostContext, OpenConnection, OpenDeviceResult } from './types.js'

class PixelhueSurfaceModule {
	readonly #logger = createModuleLogger('PixelhueSurfaceModule')
	readonly #context: HostContext
	#discovery: any = null
	/** surfaceId (per endpoint) -> OpenConnection */
	#openConnections = new Map<string, OpenConnection>()
	/** connectionId -> address:port */
	#activeConnections = new Map<string, string>()
	/** address:port -> reference count */
	#connectionRefCounts = new Map<string, number>()
	/** address:port -> shared established connection */
	#sharedConnections = new Map<string, OpenConnection>()
	/** address:port -> in-flight connect Promise (prevents concurrent duplicate connectTo) */
	#connectingPromises = new Map<string, Promise<void>>()
	/** address:port -> surfaceId (unique per endpoint) */
	#surfaceIdByAddress = new Map<string, string>()
	/** surfaceId -> address:port */
	#addressBySurfaceId = new Map<string, string>()
	/** Each connectionId is only notified as opened once */
	#openedSurfaceIds = new Set<string>()

	/**
	 * Constructor: holds host context for reporting discovery candidates, opened devices, and key events.
	 */
	constructor(hostContext: HostContext) {
		this.#context = hostContext
	}

	/**
	 * Initialize the module:
	 * 1) prepare TCP connection management for outbound connections;
	 * 2) start mDNS/Bonjour discovery and report discovered devices to the host.
	 */
	async init(): Promise<void> {
		this.#discovery = null

		const discovery = new MiniDiscoveryService()
		discovery.on('up', (device: { name?: string; address?: string; port?: number }) => {
			this.#reportDiscovered([this.#toDiscoveredInfo(device)])
		})
		discovery.on('down', (device: { address?: string; port?: number }) => {
			this.#context.connectionsForgotten([this.#connectionId(device)])
		})
		discovery?.query?.()
		this.#discovery = discovery
	}

	/**
	 * Destroy the module: tear down discovery and close all open connections.
	 */
	async destroy(): Promise<void> {
		this.#discovery?.destroy?.()
		this.#discovery = null
		for (const conn of this.#openConnections.values()) {
			try {
				conn.close()
			} catch {
				// ignore close errors during teardown
			}
		}
		this.#openConnections.clear()
		this.#activeConnections.clear()
		this.#connectionRefCounts.clear()
		this.#sharedConnections.clear()
		this.#connectingPromises.clear()
		this.#surfaceIdByAddress.clear()
		this.#addressBySurfaceId.clear()
		this.#openedSurfaceIds.clear()
	}

	/**
	 * Establish TCP connections when outbound connections are enabled.
	 * Does not proactively disconnect existing sockets; only connects connectionIds that are not open yet.
	 */
	async setupRemoteConnections(connectionInfos: RemoteSurfaceConnectionInfo[]): Promise<void> {
		this.#logger.debug(`connectionInfos: ${JSON.stringify(connectionInfos)}`)
		for (const { connectionId, config } of connectionInfos) {
			const rawAddress = config?.address ?? config?.ipAddress
			const address = rawAddress != null ? String(rawAddress).trim() : ''
			if (!address || address === '--') continue
			if (!IPV4_REGEX.test(address)) {
				this.#logger.warn(`Invalid IP address for ${connectionId}: ${address}`)
				continue
			}

			const portNum = Number(config?.port)
			const port = Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535 ? Math.floor(portNum) : DEFAULT_TCP_PORT
			const addressKey = `${address}:${port}`
			const surfaceId = this.#surfaceIdFromEndpoint(address, port)
			this.#surfaceIdByAddress.set(addressKey, surfaceId)
			this.#addressBySurfaceId.set(surfaceId, addressKey)

			// No effective change
			const oldAddressKey = this.#activeConnections.get(connectionId)
			if (oldAddressKey === addressKey) continue

			// Release old reference if target address changed
			if (oldAddressKey !== undefined) {
				this.#releaseConnectionReference(connectionId, oldAddressKey)
			}

			// Record connectionId -> addressKey mapping
			this.#activeConnections.set(connectionId, addressKey)

			const currentRefCount = this.#connectionRefCounts.get(addressKey) ?? 0
			this.#connectionRefCounts.set(addressKey, currentRefCount + 1)

			// Reuse existing socket for this address:port
			const existingShared = this.#sharedConnections.get(addressKey)
			if (existingShared) {
				this.#openConnections.set(surfaceId, existingShared)
				if (existingShared.socketWrapper?.isConnected?.()) {
					this.#notifyOpenedSurface(surfaceId, address, port)
				}
				continue
			}

			const pending = this.#connectingPromises.get(addressKey)
			if (pending) {
				await pending
				const sharedAfterPending = this.#sharedConnections.get(addressKey)
				if (sharedAfterPending) {
					this.#openConnections.set(surfaceId, sharedAfterPending)
					if (sharedAfterPending.socketWrapper?.isConnected?.()) {
						this.#notifyOpenedSurface(surfaceId, address, port)
					}
				} else {
					// Roll back mapping and ref count on concurrent connect failure
					this.#releaseConnectionReference(connectionId, addressKey)
				}
				continue
			}

			try {
				const connectPromise = (async (): Promise<void> => {
					const connectionManager = new MiniConnectionManager()
					const socketWrapper = await connectionManager.connectTo(address, port)
					this.#onConnected({ surfaceId, addressKey, socketWrapper, connectionManager, address, port })
				})()
				this.#connectingPromises.set(addressKey, connectPromise)
				await connectPromise
			} catch (error: unknown) {
				this.#logger.error(`Failed to connect to ${address}:${port}: ${JSON.stringify(error)}`)
				// Roll back ref count and related state on connection failure
				this.#releaseConnectionReference(connectionId, addressKey)
			} finally {
				this.#connectingPromises.delete(addressKey)
			}
		}
	}

	/**
	 * Stop remote connections: close sockets and clean up internal state.
	 */
	async stopRemoteConnections(connectionIds: string[]): Promise<void> {
		const dedupedConnectionIds = new Set(connectionIds)
		for (const id of dedupedConnectionIds) {
			const addressKey = this.#activeConnections.get(id)
			if (!addressKey) continue
			this.#releaseConnectionReference(id, addressKey)
		}
	}

	/**
	 * Close a surface: called when the host explicitly closes a surface.
	 */
	async closeDevice(surfaceId: string): Promise<void> {
		const addressKey = this.#addressBySurfaceId.get(surfaceId)
		if (!addressKey) return
		const idsToRelease: string[] = []
		for (const [connectionId, key] of this.#activeConnections.entries()) {
			if (key === addressKey) idsToRelease.push(connectionId)
		}
		for (const connectionId of idsToRelease) {
			this.#releaseConnectionReference(connectionId, addressKey)
		}
	}

	/**
	 * Draw: enqueue host draw requests and send sequentially via #drainDrawQueue
	 * to avoid lag and memory buildup under bursty updates.
	 */
	async draw(
		surfaceId: string,
		drawProps: Array<{
			controlId?: string
			image?: Buffer | string
			page?: unknown
		}>,
	): Promise<void> {
		const conn = this.#openConnections.get(surfaceId)
		if (!conn || conn.drawQueue.length + drawProps.length > MAX_DRAW_QUEUE_LENGTH) {
			return
		}

		for (const prop of drawProps) {
			const controlId = prop.controlId ?? ''
			const [col, row] = controlId.split('_').map(Number)
			if (isNaN(col) || isNaN(row) || !Buffer.isBuffer(prop.image)) {
				this.#logger.warn(
					`draw skipped: unsupported image type surfaceId=${surfaceId} controlId=${controlId} imageType=${typeof prop.image}`,
				)
				continue
			}

			const png = new PNG({ width: BUTTON_WIDTH, height: BUTTON_HEIGHT })
			prop.image.copy(png.data)
			const pngBytes = PNG.sync.write(png)
			const base64 = `base64,${pngBytes.toString('base64')}`

			const item: DrawItem = {
				controlId,
				page: prop.page ?? null,
				base64,
			}
			conn.drawQueue.push(item)
		}

		this.#drainDrawQueue(surfaceId)
	}

	/** Blank the surface */
	async blankSurface(_surfaceId: string): Promise<void> {}

	/** Not implemented in current protocol; kept as a no-op stub */
	async setBrightness(_surfaceId: string, _brightness: number): Promise<void> {}

	/** Not implemented in current protocol; kept as a no-op stub */
	async showStatus(_surfaceId: string): Promise<void> {}

	/** Output variable updates */
	async onVariableValue(_surfaceId: string, _name: string, _value: unknown): Promise<void> {}

	/**
	 * Locked-state display. Not used by this module; kept as a no-op stub.
	 */
	async showLockedStatus(_surfaceId: string, _locked: boolean, _characterCount: number): Promise<void> {}

	/**
	 * TCP connected callback: bind socket events and report the remote surface as opened.
	 */
	#onConnected({
		surfaceId,
		addressKey,
		socketWrapper,
		connectionManager,
		address,
		port,
	}: {
		surfaceId: string
		addressKey: string
		socketWrapper: any
		connectionManager: any
		address: string
		port: number
	}): void {
		let closed = false

		const close = (): void => {
			if (closed) return
			const current = this.#openConnections.get(surfaceId)
			if (current && current.socketWrapper !== socketWrapper) {
				return
			}
			closed = true
			try {
				connectionManager?.disconnectFrom?.(address, port, {
					autoReconnect: true,
				})
			} catch {
				// ignore disconnect errors during close
			}
			// Remove all alias connections pointing at this endpoint
			for (const [id, key] of this.#activeConnections.entries()) {
				if (key === addressKey) {
					this.#activeConnections.delete(id)
				}
			}
			this.#openConnections.delete(surfaceId)
			this.#openedSurfaceIds.delete(surfaceId)
			this.#surfaceIdByAddress.delete(addressKey)
			this.#addressBySurfaceId.delete(surfaceId)
			this.#context.disconnected?.(surfaceId)
			this.#connectionRefCounts.delete(addressKey)
			this.#sharedConnections.delete(addressKey)
		}

		const conn: OpenConnection = {
			connectionId: surfaceId,
			socketWrapper,
			connectionManager,
			address,
			port,
			close,
			drawQueue: [],
			drawQueueRunning: false,
		}
		this.#sharedConnections.set(addressKey, conn)
		this.#openConnections.set(surfaceId, conn)

		socketWrapper.on?.('connected', () => {
			this.#notifyOpenedSurface(surfaceId, address, port)

			// If there are queued draw items, try draining now
			if (conn.drawQueue.length > 0) {
				this.#drainDrawQueue(surfaceId)
			}
		})

		// Some implementations may already be connected when connectTo returns; emit opened as a fallback
		if (socketWrapper?.isConnected?.()) {
			this.#notifyOpenedSurface(surfaceId, address, port)
			if (conn.drawQueue.length > 0) {
				this.#drainDrawQueue(surfaceId)
			}
		}

		socketWrapper.on?.('data', (data: unknown, _requestId: number) => {
			this.#handleDeviceData(surfaceId, data as Record<string, unknown>)
		})
		socketWrapper.on?.('error', (error: Error) => {
			const tcpWrapper = socketWrapper.getTcpWrapper?.()
			const currentAddress = tcpWrapper?.getAddress?.() ?? 'unknown'
			const currentPort = tcpWrapper?.getPort?.() ?? 'unknown'
			this.#logger.error(`Device error [${currentAddress}:${currentPort}]: ${error.message}`)
			if (error.message?.includes?.('ECONNRESET')) {
				close()
			}
		})
		socketWrapper.on?.('disconnected', () => {
			const tcpWrapper = socketWrapper.getTcpWrapper?.()
			const currentAddress = tcpWrapper?.getAddress?.() ?? 'unknown'
			const currentPort = tcpWrapper?.getPort?.() ?? 'unknown'
			this.#logger.info(`Device connection closed [${currentAddress}:${currentPort}]`)
			close()
		})
	}

	/**
	 * Handle raw device data and convert to host input events: key press/release => inputPress
	 */
	#handleDeviceData(surfaceId: string, data: Record<string, unknown>): void {
		try {
			this.#logger.debug(`receive data surfaceId=${surfaceId} payload=${JSON.stringify(data)}`)
		} catch {
			// ignore payload stringify/log errors
		}
		if (!data || typeof data !== 'object') return

		const events = this.#context.surfaceEvents
		if (!events) return
		if (data.type === 0 || data.type === 1) {
			const pressed = data.type === 0
			const controlId = `${Number(data.column)}_${Number(data.row)}`
			this.#logger.debug(
				`send inputPress surfaceId=${surfaceId} controlId=${controlId} pressed=${pressed} data=${JSON.stringify(data)}`,
			)
			events.inputPress(surfaceId, controlId, pressed)
		}
	}

	/**
	 * Only one underlying connection per address:port. Multiple connectionIds may share the same socket;
	 * the socket is disconnected only when the ref count reaches zero.
	 */
	#releaseConnectionReference(connectionId: string, addressKey: string): void {
		this.#activeConnections.delete(connectionId)

		const currentRefCount = this.#connectionRefCounts.get(addressKey)
		if (currentRefCount === undefined) return

		if (currentRefCount <= 1) {
			this.#connectionRefCounts.delete(addressKey)
			const shared = this.#sharedConnections.get(addressKey)
			this.#sharedConnections.delete(addressKey)
			shared?.close()
		} else {
			this.#connectionRefCounts.set(addressKey, currentRefCount - 1)
		}
	}

	/**
	 * Send draw queue items one at a time, scheduling the next send with setImmediate to avoid blocking.
	 */
	#drainDrawQueue(surfaceId: string): void {
		const conn = this.#openConnections.get(surfaceId)
		if (!conn || conn.drawQueueRunning || conn.drawQueue.length === 0) return
		conn.drawQueueRunning = true

		const sendOne = (): void => {
			const c = this.#openConnections.get(surfaceId)
			if (!c) {
				conn.drawQueueRunning = false
				return
			}
			const sdkConnected = !!c.socketWrapper?.isConnected?.()
			// Guard against drawQueueRunning staying true after connection loss, which would leak memory
			if (!sdkConnected) {
				c.waitingSinceMs ??= Date.now()
				if (Date.now() - c.waitingSinceMs > CONNECT_WAIT_TIMEOUT_MS) {
					c.drawQueue.length = 0
					c.waitingSinceMs = undefined
					c.drawQueueRunning = false
					return
				}
				setTimeout(sendOne, CONNECTED_POLL_DELAY_MS)
				return
			}
			c.waitingSinceMs = undefined
			const item = c.drawQueue.shift()
			if (!item) {
				conn.drawQueueRunning = false
				return
			}

			const [col, row] = item.controlId.split('_').map(Number)
			try {
				this.#logger.info(
					`draw send surfaceId=${surfaceId} controlId=${item.controlId} column=${col} row=${row} base64Length=${item.base64.length} page=${item.page}`,
				)
				c.socketWrapper?.send?.({
					page: item.page ?? null,
					column: col,
					row,
					data: item.base64,
				})
			} catch {
				// ignore send errors; queue continues
			}

			setImmediate(() => sendOne())
		}

		sendOne()
	}

	/** Generate a unique id for connections/surfaces */
	#connectionId(device: DeviceInfoT): string {
		return `${PIXELHUE_U5_MINI_NAME}-${device.serialNumber ?? `${PIXELHUE_U5_MINI_NAME}_${device.address}_${device.port}`}`
	}

	#surfaceIdFromEndpoint(address: string, port: number): string {
		return `${PIXELHUE_U5_MINI_NAME}:${address}:${port}`
	}

	/** Convert a discovered device into a host-facing discovery candidate */
	#toDiscoveredInfo(device: DeviceInfoT): DiscoveredRemoteSurfaceInfo {
		const id = this.#connectionId(device)
		const address = device.address ?? null
		return {
			id,
			displayName: (device.name as string) ?? PIXELHUE_U5_MINI_NAME,
			description: PIXELHUE_U5_MINI_NAME,
			addresses: address,
			config: {
				address: address ?? '--',
				port: device.port ?? DEFAULT_TCP_PORT,
			},
		}
	}

	/** Report discovery candidates to the host (connectionsFound) */
	#reportDiscovered(infos: DiscoveredRemoteSurfaceInfo[]): void {
		this.#context.connectionsFound(infos)
	}

	#notifyOpenedSurface(surfaceId: string, address: string, port: number): void {
		// SDK TcpWrapper: with autoReconnect on 127.0.0.1, socket close may reconnect without emitting
		// `disconnected`, but `connected` fires again. "Notify opened only once" would skip full page redraw.
		if (this.#openedSurfaceIds.has(surfaceId)) {
			// Loopback only: matches outbound "still enabled on 127.0.0.1"; main process re-validates the outbound entry
			if (address !== '127.0.0.1') {
				return
			}
			// Same shape as IpcWrapper.sendWithNoCb; child entry requires process.send; ?. avoids throws outside a child process
			process?.send?.({
				direction: 'call',
				name: 'requestRemoteSurfaceRedraw',
				payload: { surfaceId },
				callbackId: undefined,
			})
		}

		this.#openedSurfaceIds.add(surfaceId)

		const info: OpenDeviceResult = {
			surfaceId,
			description: PIXELHUE_U5_MINI_NAME,
			configFields: null,
			surfaceLayout: DEFAULT_SURFACE_LAYOUT,
			location: `${address}:${port}`,
			isRemote: true,
			supportsBrightness: false,
		}
		this.#context.notifyOpenedDiscoveredSurface?.(info).catch((error: unknown) => {
			this.#logger.error(`Failed to notify opened discovered surface: ${JSON.stringify(error)}`)
		})
	}
}

export { PixelhueSurfaceModule }
