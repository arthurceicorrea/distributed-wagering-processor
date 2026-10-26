# Arquitetura do processador de apostas

Este documento descreve o comportamento implementado no repositório. Os testes de
integração e concorrência dependem de PostgreSQL e LocalStack; os resultados devem
ser obtidos no ambiente de execução, não inferidos a partir deste documento.

## Organização em camadas e persistência

As regras de negócio ficam em `src/domain/`, os casos de uso em `src/application/`
e os adaptadores em `src/infrastructure/`. As entidades de domínio não usam
decorators do NestJS ou do MikroORM.

O `@mikro-orm/postgresql` participa da persistência transacional em três pontos:

1. **Unidade de trabalho**: saldo, transação, razão, inbox e outbox são gravados
   na mesma transação SQL.
2. **Lock pessimista**: alterações concorrentes da mesma carteira usam
   `LockMode.PESSIMISTIC_WRITE`.
3. **Mappers**: as entidades do banco são convertidas explicitamente para os
   objetos de domínio e de volta.

O lock pessimista foi escolhido em vez de um lock global porque a unidade de
serialização é a wallet: operações de jogadores diferentes podem continuar
em paralelo, enquanto operações que alteram a mesma wallet aguardam a linha
correspondente. A versão da wallet permanece como uma garantia adicional de
auditoria, mas não substitui o lock da transação.

## Valores monetários e razão

`Money` usa `decimal.js` e exige valores no formato `/^\d+\.\d{2}$/`. As colunas
monetárias usam `NUMERIC(19, 2)` e os mappers trabalham com strings para evitar
conversões implícitas para ponto flutuante.

`wallet_ledger_entries` tem constraints para a aritmética e uma trigger que
bloqueia `UPDATE` e `DELETE`. A versão da carteira começa em `1` e muda com
alterações de saldo.

Uma migration posterior reforça no banco os valores permitidos para `kind` e
`status`, o formato de moeda de três letras maiúsculas, o formato hexadecimal
de SHA-256 dos hashes e a não negatividade das tentativas de retry. Essas
constraints existem para que uma escrita fora do caso de uso não consiga
persistir um estado que o domínio não reconhece.

## Idempotência

A chave de idempotência e a combinação `provider_id`/
`external_transaction_id` têm constraints únicas. O `payloadHash` é um SHA-256
calculado sobre JSON canônico com chaves ordenadas. A chave é verificada antes e
depois do lock da carteira.

## Referências fora de ordem

Um `REFUND` ou `ROLLBACK` sem a transação referenciada fica com status
`PENDING_REFERENCE`, gera o evento correspondente na Outbox e pode responder
`202 Accepted`.

O índice parcial `uq_wager_tx_reversal_once` limita reversões processadas para a
mesma transação original. O `PendingReferenceWorker` busca registros elegíveis
com `FOR UPDATE SKIP LOCKED` e aplica o limite definido em
`MAX_REFERENCE_RETRY_ATTEMPTS`.

Quando a referência ainda não existe, o retry usa backoff exponencial limitado
a cinco tentativas. Após o limite, a transação é marcada com
`REFERENCE_NOT_FOUND_TIMEOUT`; isso evita polling infinito e deixa o caso
disponível para reconciliação operacional.

## Inbox, outbox e autenticação

O consumidor SQS grava a mensagem na Inbox dentro da mesma transação das
alterações de domínio. O publicador da Outbox usa `FOR UPDATE SKIP LOCKED` e
`MessageGroupId` para manter a ordem por carteira.

Com `OIDC_JWKS_URI`, `ProviderAuthGuard` valida o token via JWKS remoto e compara
`provider_id` com o `providerId` recebido. Sem essa variável, o adaptador usa a
identidade local de desenvolvimento.

O logger estruturado escreve JSON no stdout e remove campos sensíveis conhecidos,
como `authorization`, `password`, `token`, `secret`, `apikey` e `cookie`.

O fallback local não é uma autenticação de produção; ele existe para manter o
ambiente local executável sem um IdP. Em produção, a configuração deve fornecer
o JWKS do provedor de identidade.

## Entrega de mensagens e recuperação

O consumidor SQS usa entrega at-least-once. Mensagens permanentes ou com cinco
recebimentos são copiadas para a DLQ e removidas da fila principal. Falhas
transitórias mantêm a mensagem na fila e ajustam a visibilidade com backoff
exponencial, limitado a 30 segundos. Durante o shutdown, mensagens recebidas
que ainda não começaram a ser processadas têm a visibilidade zerada; a
mensagem em processamento termina antes do módulo encerrar.

O publicador da Outbox também é at-least-once: ele seleciona lotes com
`FOR UPDATE SKIP LOCKED`, publica fora do lock de seleção e marca cada linha
como publicada em uma nova transação. Por isso consumidores devem tratar
duplicatas usando `eventId`. O `MessageGroupId` é derivado do aggregate para
preservar a ordem por wallet sem transformar todas as wallets em uma única
fila serial.

## Observabilidade e teste de carga

As métricas são mantidas em memória e expostas para diagnóstico local; elas
não participam de idempotência, saldo ou decisão de commit. Em um ambiente
de produção, devem ser exportadas para um backend de métricas antes do
processo ser reiniciado, caso seja necessário histórico.

O teste de carga cria 20 wallets, executa 25 operações por wallet em lotes de
até cinco operações concorrentes e publica a Outbox durante a carga. Ao final,
ele valida cada wallet por reconciliação e imprime duração, throughput,
contagem de latências com p50/p95/p99 e as métricas coletadas. Os números
dependem do hardware, do PostgreSQL e do LocalStack usados; não são tratados
como benchmark universal.
