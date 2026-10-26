import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DomainExceptionFilter } from "./infrastructure/http/domain-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  const orm = app.get(MikroORM);
  await orm.getMigrator().up();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

if (import.meta.main) {
  bootstrap();
}
