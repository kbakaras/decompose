# Decompose: архитектура

## 1. Архитектурные цели

Архитектура должна соответствовать реальному масштабу проекта:

- небольшая команда разработчиков;
- максимум одна компания;
- self-hosted использование;
- один экземпляр приложения в обычном сценарии;
- отсутствие требований Internet-scale SaaS.

Основной принцип:

> Использовать готовые компоненты для rendering, layout и collaboration; собственный код сосредоточить на предметной модели и UX Decompose.

## 2. Текущий выбранный стек

### Frontend

- **TypeScript**
- **React**
- **React Flow** — canvas, nodes, edges, viewport, drag, selection и базовая графическая механика
- **ELK.js** — автоматический hierarchical layout
- **Yjs** — CRDT и collaborative data model
- **y-indexeddb** — локальное хранение Yjs-документа в браузере

### Backend

- **Node.js**
- **TypeScript**
- **Hocuspocus** — WebSocket collaboration server для Yjs, встроенный в основной backend
- **SQLite** — persistence и application metadata

### Тесты

Предварительно:

- **Vitest** — unit tests
- **fast-check** — property-based tests для операций над деревом и инвариантов
- **Playwright** — UI и multi-client collaboration tests

## 3. Целевая схема

```text
┌─────────────────────────────────────────────┐
│ Browser                                     │
│                                             │
│ React                                       │
│ React Flow                                  │
│ ELK.js                                      │
│ Yjs                                        │
│ y-indexeddb                                │
└──────────────────┬──────────────────────────┘
                   │
                HTTP / WS
                   │
┌──────────────────▼──────────────────────────┐
│ Decompose backend                           │
│                                             │
│ Node.js + TypeScript                        │
│ HTTP API                                    │
│ Hocuspocus                                  │
│ Auth                                        │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ SQLite                                      │
└─────────────────────────────────────────────┘
```

Ожидаемый deployment:

```text
docker compose
└── decompose
    └── persistent volume
        └── decompose.sqlite
```

Цель: один application service и один persistent volume.

## 4. Почему Node.js

Node.js выбран не как универсально «лучший backend», а как самый прямой путь к зрелому Yjs/Hocuspocus стеку.

Преимущества для MVP:

- Hocuspocus работает в родной экосистеме;
- frontend и backend используют TypeScript;
- можно разделять общие типы;
- меньше собственной реализации collaboration protocol;
- ниже риск ошибок в CRDT sync.

Go + ygo остаётся потенциальной альтернативой на будущее, если появится реальная польза от single binary и более лёгкого runtime. Для MVP переход на Go не планируется.

## 5. Почему SQLite

SQLite выбран как основное хранилище, потому что ожидаемый масштаб невелик:

- один backend instance;
- небольшое число пользователей;
- умеренное число документов;
- отсутствие тяжёлой серверной аналитики;
- отсутствие сложного multi-tenant SaaS.

PostgreSQL не требуется на старте.

Переход к PostgreSQL следует рассматривать только при появлении конкретной причины, а не заранее.

## 6. Разделение состояния

Состояние нужно разделять как минимум на три категории.

### 6.1. Domain state

Хранится и синхронизируется через Yjs.

Примеры:

- node id;
- text;
- kind;
- status;
- parent;
- sibling order;
- другие семантические свойства.

### 6.2. Presence

Эфемерное состояние collaboration.

Примеры:

- пользователь online;
- выбранный узел;
- редактируемый узел;
- cursor/presence metadata.

Предположительно используется Yjs Awareness.

### 6.3. Local UI state

Не синхронизируется как доменная модель.

Примеры:

- viewport;
- zoom;
- локальное выделение;
- открытое меню;
- временная позиция при drag;
- промежуточная геометрия layout.

Для него может использоваться React state или Zustand.

## 7. Structure is data; coordinates are view

Предварительное решение:

Не хранить вычисленные `x/y` как источник истины.

В предметной модели хранить:

- parent relationship;
- sibling order;
- возможно, explicit layout hints, если они реально понадобятся.

ELK.js вычисляет координаты на клиенте.

Это означает, что два клиента могут иметь немного различную пиксельную геометрию при сохранении одной и той же смысловой структуры.

## 8. Layout

Основной алгоритм:

- ELK layered;
- направление слева направо;
- layout должен уважать model order;
- по возможности учитывать mental map пользователя при перестроении.

Важно различать:

- перестановку sibling-узлов как доменную операцию;
- свободное перетаскивание узла как UI-жест, который приводит к изменению порядка или parent relationship.

Не следует хранить обычный drag как произвольные координаты, если его смысл можно выразить структурной операцией.

## 9. Collaboration и модель дерева

Наивная модель вида:

```text
Node {
  children: [...]
}
```

может создать проблемы при concurrent reparent.

Предпочтительно проектировать узел так, чтобы у него был единственный parent relationship, например концептуально:

```text
Node {
  id
  parentId
  orderKey
}
```

Но точная CRDT-модель ещё не определена.

Особенно важно решить:

- concurrent reparent одного узла;
- delete vs edit;
- delete vs move;
- создание циклов;
- orphan nodes;
- sibling ordering;
- root invariants.

Эти вопросы должны быть решены до написания устойчивой domain layer.

## 10. Текст узла

Rich-text editor в первой версии не нужен.

Предпочтительно:

- plain text;
- automatic wrapping;
- automatic height;
- динамическое измерение node size;
- relayout после изменения размера.

Точная политика ширины пока открыта.

## 11. Backend scope

Backend должен оставаться небольшим.

Вероятные обязанности:

- auth;
- выдача static frontend;
- document metadata;
- permissions;
- WebSocket collaboration;
- persistence;
- backup-friendly storage.

Не следует вводить отдельные сервисы, пока нет реальной необходимости.

## 12. Auth

Точное решение не принято.

Желательный диапазон вариантов:

```text
AUTH_MODE=none
AUTH_MODE=password
AUTH_MODE=oidc
```

Но это пока не обязательный контракт.

Для закрытой среды допускается максимально простой режим.

## 13. Что пока сознательно не проектируем

- горизонтальное масштабирование;
- Redis;
- Kubernetes;
- сложный multi-tenancy;
- billing;
- публичный SaaS;
- сложный RBAC;
- аналитическое хранилище;
- distributed transactions;
- отдельный Spring Boot backend.

Если что-то из этого когда-нибудь понадобится, решение должно приниматься по фактической потребности.
