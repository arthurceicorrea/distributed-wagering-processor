# Processador distribuído de apostas

Serviço transacional para processamento distribuído de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com aritmética decimal estrita, controle de concorrência por carteira, idempotência persistente e integração via Transactional Inbox/Outbox.

## Requisitos

- Bun 1.2 ou superior para executar a aplicação e os testes.
- Docker com suporte a Compose para PostgreSQL e LocalStack.

O Bun é o runtime, gerenciador de dependências e test runner do projeto. O
`bun.lock` registra a resolução das dependências e deve ser usado junto com
`bun install --frozen-lockfile` em ambientes reproduzíveis.

## Como rodar localmente

### 1. Subir a infraestrutura (PostgreSQL, LocalStack SQS e 3 nós da API)

```bash
docker compose up -d --build
```

### 2. Instalar dependências e rodar migrations

```bash
bun install --frozen-lockfile
bun run migration:up
```

### 3. Executar os testes

```bash
# Testes unitários (domínio, Money, invariantes e hash canônico)
bun run test

# Testes de integração (PostgreSQL, triggers de imutabilidade, LocalStack SQS, DLQ e Outbox)
bun run test:integration

# Testes de concorrência (3 instâncias, corrida de saldo, falha antes de ACK e refund fora de ordem)
bun run test:concurrency

# Suíte completa
bun run test:all

# Teste de carga e reconciliação
bun run test:load
```

## Mapeamento HTTP e Códigos de Falha (`FailureCode`)

| Cenário | HTTP Status | `FailureCode` / `error` | Ação esperada do integrador |
|---|---|---|---|
| Transação processada ou replay idempotente | `200 OK` | - | Sucesso (checar flag `idempotentReplay`) |
| Referência pendente (`REFUND`/`ROLLBACK` fora de ordem) | `202 Accepted` | - | Aguardar resolução assíncrona ou consultar status |
| Payload inválido ou valor monetário fora do padrão | `400 Bad Request` | `INVALID_MONEY` / `INVALID_INPUT_CONTRACT` | Corrigir payload; não reenviar |
| Carteira ou transação não encontrada | `404 Not Found` | `ENTITY_NOT_FOUND` | Validar identificadores |
| Reuso de `Idempotency-Key` com payload divergente | `409 Conflict` | `IDEMPOTENCY_PAYLOAD_CONFLICT` | Gerar nova chave ou corrigir payload |
| Saldo insuficiente na aposta (`BET`) | `422 Unprocessable Entity` | `INSUFFICIENT_FUNDS` | Não reenviar; saldo insuficiente |
| Estorno deixaria a carteira negativa | `422 Unprocessable Entity` | `REVERSAL_INSUFFICIENT_FUNDS` | Encaminhar para revisão operacional |
| Transação original já estornada | `422 Unprocessable Entity` | `ALREADY_REVERSED` | Descartar duplicata |
| Moeda da operação difere da carteira | `422 Unprocessable Entity` | `CURRENCY_MISMATCH` | Ajustar código ISO-4217 |
| Indisponibilidade temporária de infra | `503 Service Unavailable` | `TRANSIENT_INFRASTRUCTURE_ERROR` | Reenviar com backoff mantendo `Idempotency-Key` |

## Teste de carga

O comando `bun run test:load` cria carteiras de teste, executa operações concorrentes,
publica os eventos pendentes e compara o saldo com o razão. A duração e o throughput
variam conforme o ambiente; o script imprime um relatório ao final da execução.

O cenário atual usa 20 carteiras, 25 operações por carteira e lotes de até cinco
operações concorrentes por carteira. O relatório inclui duração, throughput,
consistência de todas as carteiras, p50/p95/p99 de latência, status das
transações, duplicatas, retries, mensagens na DLQ, conflitos de lock,
divergências de reconciliação e outbox lag. Para comparar execuções, registre
o hardware, as versões do Bun/PostgreSQL/LocalStack, o número de operações e
o relatório JSON produzido pelo comando; os números não são benchmarks
universais.

### Execução verificada em 26/10/2026

Ambiente: Windows x64, Bun 1.4.4, Docker Engine 29.7.2, PostgreSQL 16.15 e
LocalStack 3.6.0. Foram executadas 500 operações em 20 carteiras, com lotes
de até cinco operações concorrentes por carteira.

| Métrica | Resultado |
|---|---:|
| Duração | 20,29 s |
| Throughput | 24,65 operações/s |
| Operações processadas | 500 |
| Carteiras consistentes | Sim |
| p50 de latência | 3189,87 ms |
| p95 de latência | 5158,68 ms |
| p99 de latência | 5482,70 ms |
| Duplicatas detectadas | 0 |
| Retries | 0 |
| Mensagens na DLQ | 0 |
| Conflitos de lock | 0 |
| Divergências de reconciliação | 0 |
| Outbox lag observado | 16704 ms |

Esse resultado é uma execução local única e serve como registro de
reprodutibilidade, não como garantia de desempenho em outros ambientes.

## Validação

Os comandos abaixo validam o código sem infraestrutura:

```bash
bun run typecheck
bun run build
bun run test
```

`bun run test:all`, `bun run test:integration`, `bun run test:concurrency`,
`bun run migration:up` e `bun run test:load` exigem PostgreSQL e LocalStack
disponíveis pelo Docker Compose.

Na validação realizada em 26/10/2026, `bun run test:all` concluiu com 25 testes
passando, 199 asserções e nenhuma falha. Os três nós do Compose também
responderam `200 OK` em `/health/live`, e a migration foi aplicada até a versão
mais recente.
