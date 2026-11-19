import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // Typed as the Express application so that Express-specific settings —
  // trust proxy, below — are available without casting.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('API_PORT', 4000);
  const isProduction = config.get<string>('NODE_ENV') === 'production';

  app.setGlobalPrefix('api/v1');

  // Behind a proxy, req.ip must come from X-Forwarded-For or every audit
  // entry records the load balancer's address instead of the client's.
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      // NFR-S-07. `whitelist` strips any property not declared on the DTO and
      // `forbidNonWhitelisted` rejects the request outright if extras are
      // present — so a client cannot smuggle `role: 'ADMIN'` into a
      // registration body and have it quietly assigned.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Validation messages are user-facing text (NFR-U-05), so they are kept
      // in production rather than replaced with a generic "Bad Request".
      disableErrorMessages: false,
    }),
  );

  app.enableCors({
    origin: isProduction
      ? [config.get<string>('WEB_DASHBOARD_URL') ?? '', config.get<string>('WEB_ADMIN_URL') ?? '']
      : true,
    credentials: true,
  });

  // API documentation, off in production: it enumerates every endpoint and
  // every field, which is a map for anyone probing the service.
  if (!isProduction) {
    const doc = new DocumentBuilder()
      .setTitle('Hoppo API')
      .setDescription(
        'College-scoped delivery and student networking platform. ' +
          'Requirement identifiers in descriptions refer to docs/srs/srs-v1.md.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();

    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
    logger.log(`API docs at http://localhost:${port}/api/docs`);
  }

  // Finish in-flight requests before exiting, rather than dropping them.
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Hoppo API listening on http://localhost:${port}/api/v1`);
}

void bootstrap();
