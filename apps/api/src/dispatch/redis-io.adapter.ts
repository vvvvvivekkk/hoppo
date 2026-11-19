import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { INestApplicationContext } from '@nestjs/common';
import type { ServerOptions } from 'socket.io';
import type Redis from 'ioredis';

/**
 * Socket.IO with the Redis adapter, so one broadcast reaches sockets held by
 * every API instance rather than only the one that sent it.
 *
 * This is a custom `IoAdapter` rather than something the gateway does to
 * itself, because the adapter has to be attached to the Socket.IO *server*
 * before any namespace is created. Doing it from inside the gateway does not
 * work: `onModuleInit` runs before the server exists, and a namespaced
 * gateway's `afterInit` receives a `Namespace`, whose `adapter` is the
 * adapter instance rather than a setter. Both fail quietly, leaving realtime
 * working on a single instance and silently broken on two — the worst kind of
 * bug to find in production.
 *
 * Wired in main.ts with `app.useWebSocketAdapter()`.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly pubClient: Redis,
    private readonly subClient: Redis,
  ) {
    super(app);
  }

  /** Called once at startup, before any gateway is created. */
  async connect(): Promise<void> {
    // Both clients must be live before the adapter is built; attaching over a
    // still-connecting client drops the first messages.
    await Promise.all([this.pubClient.ping(), this.subClient.ping()]);
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.log.log('Redis pub/sub clients ready for the WebSocket adapter');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);

    if (this.adapterConstructor) {
      (server as { adapter: (a: unknown) => void }).adapter(this.adapterConstructor);
      this.log.log('WebSocket Redis adapter attached');
    } else {
      // A single instance still works. Logged loudly rather than silently,
      // because the failure mode only shows up once a second instance exists.
      this.log.warn(
        'Redis adapter unavailable; realtime will not fan out across API instances',
      );
    }

    return server;
  }
}
