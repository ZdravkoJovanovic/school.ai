import type { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

export interface InitSocketsOptions {
	origin?: string | string[];
}

/**
 * Initialisiert Socket.IO auf demselben HTTP-Server (gleicher Port wie Express).
 * CORS wird auf die angegebene Origin (z. B. NGROK_URL) begrenzt – fallback '*'.
 */
export function initSockets(httpServer: HttpServer, options?: InitSocketsOptions) {
	const io = new Server(httpServer, {
		path: '/ws',
		transports: ['websocket'],
		cors: {
			origin: options?.origin || '*',
			methods: ['GET', 'POST'],
			credentials: false,
		},
	});

	const ns = io.of('/classlink');

	io.engine.on('connection', (rawSocket: any) => {
		try { console.log('🔎 [SOCKET] Engine connection from', rawSocket?.request?.headers?.origin || rawSocket?.request?.socket?.remoteAddress); } catch {}
	});

	ns.on('connection', (socket: Socket) => {
		const role = String((socket.handshake.auth as any)?.role || socket.handshake.query?.role || 'desktop');
		const sidRaw = (socket.handshake.auth as any)?.sid || socket.handshake.query?.sid || '';
		const sid = String(sidRaw || '').trim();
		const room = sid ? `classlink:${sid}` : `classlink:${socket.id}`;
		socket.join(room);

		if (role === 'mobile') {
			console.log('📱 [SOCKET] Mobile verbunden:', sid || socket.id);
		} else {
			console.log('🖥️  [SOCKET] Desktop verbunden:', sid || socket.id);
		}

		// Desktop → Mobile Steuerung
		socket.on('start', () => ns.to(room).emit('start'));
		socket.on('stop', () => ns.to(room).emit('stop'));

		// Mobile → Desktop Frames (später OCR-Pipeline)
		socket.on('frame', (payload: { seq: number; ts: number; data: ArrayBuffer | string }) => {
			// In einer späteren Iteration könnte hier Throttling/Worker-Anbindung erfolgen
			ns.to(room).emit('frame', payload);
		});

		socket.on('status', (msg: any) => ns.to(room).emit('status', msg));

		socket.on('disconnect', (reason: string) => {
			console.log('🔌 [SOCKET] Disconnect:', sid || socket.id, reason);
		});
	});

	return io;
}


