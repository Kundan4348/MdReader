# Diagrams fixture

Used by `test/diagram-test.mjs`. One of each common kind, a broken one, and an untagged fence that starts with a diagram word.

## Order flow

```mermaid
---
title: Order handling
---
flowchart TD
    A([Customer places order]) --> B[Validate order]
    B --> C{In stock?}
    C -- yes --> D[Reserve items]
    C -- no --> E[/Notify customer/]
    D --> F[(Orders DB)]
    D --> G[Charge card]
    G -.->|async| H[Send receipt]
    E --> Z([Done])
    H --> Z
    subgraph Fulfilment
        D
        G
    end
```

## Login sequence

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant W as Web app
    participant API
    participant DB as Database
    U->>W: open login page
    W->>API: POST /login
    API->>DB: find user
    DB-->>API: user row
    alt password ok
        API-->>W: 200 + token
        W-->>U: show dashboard
    else wrong password
        API-->>W: 401
        W-->>U: show error
    end
    loop every 5 min
        W->>API: refresh token
        API-->>W: new token
    end
    Note over API,DB: tokens expire after 1 h
```

## Classes

```mermaid
classDiagram
    class Animal {
        +String name
        +eat()
    }
    class Dog
    class Cat
    class Owner
    Animal <|-- Dog
    Animal <|-- Cat
    Owner o-- Dog : walks
    Owner --> Cat : feeds
```

## Ticket states

```mermaid
stateDiagram-v2
    [*] --> Open
    Open --> InProgress : assigned
    InProgress --> Resolved : fix deployed
    Resolved --> Closed : verified
    Resolved --> Open : reopened
    Closed --> [*]
```

## Share of tickets

```mermaid
pie title Tickets by type
    "Alarm" : 42
    "TOA" : 18
    "AsBuilt" : 11
    "Other" : 7
```

## Plan

```mermaid
gantt
    title Switch accuracy baseline
    dateFormat YYYY-MM-DD
    section Pull
    AsBuilt export      :a1, 2026-09-22, 4d
    Happoshu lookup     :a2, after a1, 3d
    section Compare
    Join and grade      :b1, after a2, 5d
    Write-up            :b2, after b1, 2d
```

## Untagged

```
flowchart LR
    S[Start] --> T[Finish]
```

## Broken on purpose

```mermaid
flowchart LR
    A[Start] --> B[Middle
    B --> C[End]
```

Closing paragraph after the diagrams.
