import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: "consumer_name", type: "varchar", length: 128 })
  consumerName!: string;

  @PrimaryKey({ fieldName: "message_id", type: "varchar", length: 128 })
  messageId!: string;

  @Property({ fieldName: "payload_hash", type: "varchar", length: 64 })
  payloadHash!: string;

  @Property({ fieldName: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  @Property({ fieldName: "processed_at", type: "timestamptz", nullable: true })
  processedAt?: Date;
}
