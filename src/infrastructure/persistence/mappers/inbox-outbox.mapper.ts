import { InboxMessage } from "../../../domain/inbox-message";
import { OutboxMessage } from "../../../domain/outbox-message";
import { InboxMessageEntity } from "../entities/inbox-message.entity";
import { OutboxMessageEntity } from "../entities/outbox-message.entity";

export class InboxOutboxMapper {
  static toInboxEntity(domain: InboxMessage): InboxMessageEntity {
    const entity = new InboxMessageEntity();
    entity.consumerName = domain.consumerName;
    entity.messageId = domain.messageId;
    entity.payloadHash = domain.payloadHash;
    entity.receivedAt = domain.receivedAt;
    entity.processedAt = domain.processedAt;
    return entity;
  }

  static toOutboxEntity(domain: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    entity.id = domain.id;
    entity.aggregateId = domain.aggregateId;
    entity.eventType = domain.eventType;
    entity.payload = { ...domain.payload };
    entity.occurredAt = domain.occurredAt;
    entity.attempts = domain.attempts;
    entity.nextAttemptAt = domain.nextAttemptAt;
    entity.publishedAt = domain.publishedAt;
    return entity;
  }
}
