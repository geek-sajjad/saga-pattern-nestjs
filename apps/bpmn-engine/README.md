# Mini BPMN: build-your-own BPMN tool

A small BPMN tool built for learning. It runs the same freight-forwarding saga as `apps/orchestrator`, except this time
the flow is a **diagram** and a generic **engine** runs it. The orchestrator hand-codes that flow in TypeScript.

```
npm run start:participants      # the 5 services the saga talks to (terminal 1)
npm run start:bpmn              # the BPMN tool (terminal 2)
open http://localhost:3200/
```

Port: `BPMN_PORT` (default 3200). State: `data/bpmn-engine.sqlite` (`npm run db:reset` wipes it).

---

## 1. What is BPMN, and what is a "BPMN tool"?

**BPMN 2.0** (Business Process Model and Notation) is an OMG standard for drawing business processes. It is two things at once:

1. **A notation** that business people can read: circles are events, rounded boxes are tasks, diamonds are decisions.
2. **An XML format** with exact execution semantics, so a machine can run the same drawing.

That second point is the big idea. The diagram is the program: analysts and developers look at the same artifact, and
changing the process can mean redrawing an arrow instead of rewriting code.

A "BPMN tool" (Camunda, Flowable, jBPM, Activiti, Bonita…) always has the same three parts. This repo has all three:

| Part | Job | Here | Real-world example |
|---|---|---|---|
| **Modeler** | Draw the diagram, save it as `.bpmn` XML | *Modeler* tab ([public/index.html](public/index.html), uses `bpmn-js`) | Camunda Modeler, bpmn.io |
| **Engine** | Parse the XML, run *instances* of it, persist their state, call your code | [src/engine/](src/engine/) | Camunda 7/8 (Zeebe), Flowable |
| **Cockpit** | See running instances, complete human tasks, fix failures | *Cockpit* tab | Camunda Operate / Tasklist / Cockpit |

```
  Modeler ──(deploy XML)──▶ Engine ──(calls)──▶ your code (handlers) ──▶ ocean-carrier, customs, …
     ▲                      │  ▲                                        (the existing TCP services)
     │                      ▼  │ complete task / retry
  .bpmn file           SQLite  Cockpit
```

## 2. Anatomy of a `.bpmn` file

Open [processes/quote-approval.bpmn](processes/quote-approval.bpmn). It has two halves:

```xml
<bpmn:definitions xmlns:mini="https://example.com/mini-bpmn" …>
  <bpmn:process id="quote-approval" isExecutable="true">            <!-- ① WHAT runs: the graph -->
    <bpmn:startEvent id="Start_Quote" />
    <bpmn:serviceTask id="Task_Calculate" mini:handler="quote.calculate" />
    <bpmn:exclusiveGateway id="Gw_Big" default="Flow_Small" />
    <bpmn:sequenceFlow id="Flow_Big" sourceRef="Gw_Big" targetRef="Task_Approve">
      <bpmn:conditionExpression>${quote.amount > 10000}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    …
  </bpmn:process>
  <bpmndi:BPMNDiagram>                                              <!-- ② WHERE it is drawn: x/y -->
    <bpmndi:BPMNShape bpmnElement="Task_Calculate"><dc:Bounds x="240" y="220" … /></bpmndi:BPMNShape>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
```

- **① The process** is a directed graph: *flow nodes* (events, tasks, gateways) connected by *sequence flows*. This is all the engine reads.
- **② The diagram (DI)** is only coordinates, for the modeler and viewer. The engine ignores it.
- **Extension attributes** (`mini:handler`, `mini:formFields`) are how *every* vendor connects the standard to real code,
  each in its own namespace: Camunda 8 uses `zeebe:taskDefinition type="…"`, Flowable uses `flowable:class="…"`.

## 3. How the engine works: token passing

The whole engine rests on one idea, which you can watch in the cockpit: **a process instance holds tokens, and each token sits on a node.**
The engine keeps picking a `READY` token and runs that node's behaviour
([bpmn-engine.service.ts](src/engine/bpmn-engine.service.ts), method `execute`):

| Element | Symbol | Behaviour |
|---|---|---|
| Start event | ○ | Move along the outgoing flow |
| Service task | ▢⚙ | Run the handler code, merge its result into the variables, move on |
| User task | ▢👤 | **Wait state.** Park the token until a person completes the task in the cockpit |
| Receive task | ▢✉ | **Wait state.** Park the token until a matching message arrives (`POST /api/messages`) |
| Timer / message catch event | ◎🕒 ◎✉ | **Wait state.** Park the token until the duration (`PT15S`) passes or the message arrives |
| Exclusive gateway (XOR) | ◇ | Take the **first** outgoing flow whose condition is true, else the `default` flow |
| Parallel gateway (AND) | ◇+ | **Fork:** one token per outgoing flow. **Join:** wait until a token arrived on *every* incoming flow, then merge them |
| Event-based gateway | ◇⬠ | **Race.** Subscribe to every event after it (messages, timers); the first one to happen wins, the others are dropped |
| Sub-process | ▭ around a graph | Park the token on the sub-process and start a child token at its start event. When the last token inside ends, continue |
| Call activity | ▢ thick border | Start a **separate instance** of another process (the version picked by its binding) and wait until it ends |
| Multi-instance activity | ▢ ⦀ or ☰ | Run the activity once per item of a list, in parallel (⦀) or one after another (☰); collect the results |
| Error boundary event | ⚡ on an activity | If the activity (or anything inside it) throws that BPMN error, abandon it and continue from here |
| Timer / message boundary event | 🕒 ✉ on an activity | While the activity waits: **interrupting** (solid) cancels it and continues here; **non-interrupting** (dashed) starts an extra token here and keeps the activity waiting |
| Compensation throw event | ⏪ | Run the compensation handlers of the **completed** activities in **reverse order** |
| End event | ● | Consume the token. No tokens left = scope done (sub-process continues, or the instance is `COMPLETED`) |
| Terminate end event | ◉ | Remove every other token **of its scope** (the whole instance, or just the sub-process) |
| Error end event | ⓧ | Throw a BPMN error. It travels outwards: enclosing sub-processes, then the calling process |

In pseudo-code, the engine is:

```ts
while (instance has a READY token) {
  execute(token.node)   // may move the token, fork it, park it (WAITING) or fail it (INCIDENT)
  save(instance)        // after EVERY step: a crash loses nothing
}
// stop: every remaining token waits for a person, a timer, a join, or an operator
```

### Concepts worth knowing (each one is in the code)

| Concept | What it means | Where |
|---|---|---|
| **Definition vs instance** | The deployed diagram is a *class*, each run of it is an *object* with its own tokens and variables | [entities.ts](src/engine/entities.ts) `Deployment`, `ProcessInstance` |
| **Versioning** | Deploying the same process key again creates **v2**. Running instances stay on the version they started with, and the cockpit draws that exact version. See [section 5](#5-versioning-and-migration) | `deploy()`, `definition(key, version)` |
| **Scopes (token tree)** | A token entering a sub-process stays on it (so its boundary events can fire) and a child token runs inside. Every token knows its `scopeId`; an interrupting event removes everything below it | `Token.scopeId`, `descendants()`, `interrupt()` |
| **Error propagation** | A BPMN error looks for a catcher outwards: the task's boundary, the enclosing sub-process, its parent… then the calling process. Nothing catches it? Incident (or, in a called instance, the instance ends as `TERMINATED` and hands the error to its caller) | `throwError()` |
| **Messages & correlation** | A waiting token *subscribes* to a message name plus a correlation key evaluated at that moment (`${shipmentRef}` → `IMP-1A2B3C`). `POST /api/messages` delivers to every instance with a matching subscription. No buffering: a message nobody waits for is dropped | `subscribe()`, `correlateMessage()` |
| **Subscriptions** | Everything a waiting token listens for (own timer/message, the events after an event-based gateway, timer/message boundaries) is one list on the token. The first one to fire decides | `Token.subscriptions`, `fire()` |
| **Call activity** | The child is a separate instance with its own variables, history and version. `mini:inputs` / `mini:outputs` choose what crosses the border. Parent and child talk through "after save" hooks, and a restart repairs links a crash broke | `startCallActivity()`, `onChildEnded()`, `resumeAfterRestart()` |
| **Multi-instance** | The arriving token becomes the loop *body*; one child token per item carries the item as a **local** variable. Results land in the iteration, not the process, so parallel iterations don't overwrite each other | `startLoop()`, `writeVariables()` |
| **Parsing & validation** | Deployment rejects diagrams the engine can't run (dead ends, unreachable nodes, XOR flows without conditions, unsupported elements) | [bpmn-parser.ts](src/engine/bpmn-parser.ts) `validate()` |
| **Process variables** | The data travelling with the instance. Handlers read them and return changes; conditions are evaluated against them | `variables`, [expressions.ts](src/engine/expressions.ts) |
| **Wait states & persistence** | User tasks and timers can last days. The instance lives in SQLite, not in memory. Restart the engine while a timer runs and it still fires | `fireDueTimers()`, `resumeAfterRestart()` |
| **Business error vs technical error** | `throw new BpmnError(code)` is an outcome the *diagram* handles (error boundary event). Any other exception is an **incident**: the token stops and an operator must retry | [handlers.ts](src/engine/handlers.ts), `executeServiceTask()` |
| **Incidents & retry** | "trucking is down" isn't a business outcome, so it isn't drawn. The token waits in `INCIDENT` until someone fixes the cause and clicks *Retry* (optionally after editing variables) | `retryIncident()`, `setVariables()` |
| **At-least-once execution** | The token is saved as `EXECUTING` before a handler runs. After a crash the handler runs **again**, so handlers must be idempotent (the participants key everything by `sagaId` = instance id) | `executeServiceTask()`, `resumeAfterRestart()` |
| **Compensation (BPMN's built-in saga)** | Each forward task has a compensation boundary event ⏪ linked (dotted *association*) to its undo task. The throw event undoes completed tasks in reverse; already-undone ones are skipped on retry | `compensate()` |
| **Handlers (glue code)** | The diagram says *what* happens and in which order; handlers say *how*. They are tiny | [freight-handlers.ts](src/handlers/freight-handlers.ts) |

## 4. Things to try

**Shipment saga** ([processes/shipment-saga.bpmn](processes/shipment-saga.bpmn)): use the presets in *Start an instance*.

| Preset | What you'll see |
|---|---|
| Happy path | 5 green tasks → "Shipment booked" |
| Customs rejects / No warehouse / Credit limit | Red ⚡ on the failing task → "Undo completed bookings" → orange undo tasks, **only for tasks that completed**, newest first |
| Timeout → incident | Trucking commits but replies too late, so you get a red incident (*outcome unknown*). Click **Edit** on the variables, delete `"simulate"`, save, then **Retry**. Trucking returns the booking it already made (idempotency) and the saga finishes |
| Flaky compensation → incident | Customs' undo fails twice: two incidents on the compensation event. Retry twice: warehouse and trucking are **not** undone again |
| *Stop a participant* (Ctrl+C), start a saga | Incident "not running (ECONNREFUSED)". Start it again, Retry |

**Quote approval** ([processes/quote-approval.bpmn](processes/quote-approval.bpmn)):

- *Small quote*: the XOR takes the default "no" flow and skips approval. Then the AND gateway forks: "Notify sales" finishes immediately, while "Customer signs contract" waits. Watch the join show *waiting* until you complete the form, then the 15 s timer.
- *Big quote*: complete "Manager approves quote" with `approved` unticked to take the rejection path.

**Change a process without touching TypeScript:**

1. *Open in modeler* → shipment saga. Drag "Book trucks" after "Reserve warehouse space" (reconnect the arrows).
2. **Deploy**. You get **v2**. Old instances still show v1 in the cockpit; new ones run the new order.
3. Try deploying something broken (a task with no outgoing flow) and read the engine's validation errors.
4. Add a user task "Ops double-checks the booking" before billing and set *mini:formFields* to `ok:boolean` in the side panel.

### Door-to-door import: everything at once

[processes/import-shipment.bpmn](processes/import-shipment.bpmn) is the full journey of an import, from order to invoice.
It calls [customs-clearance](processes/customs-clearance.v2.bpmn) as a separate process.

```
order ─▶ risk? ─┬─ low ──────────────────────────────┐
                ├─ high ─▶ compliance review ─▶ ok? ──┤   (20s reminder ┄ non-interrupting, 45s escalation ─ interrupting)
                └─ blocked ─▶ refuse                  ▼
   ┌─ Book the transport chain (sub-process) ───────────────┐
   │  ┌▶ vessel ─┐                                          │ ⚡BOOKING_REJECTED ─▶ ⏪ undo what was booked
   │ ─┤          ├─▶ trucks                                │
   │  └▶ warehouse┘                                        │
   └───────────────────────────────────────────────────────┘
 ─▶ Customs clearance (call activity, versionTag ${customsRelease}) ⚡CARGO_SEIZED ─▶ ⏪ cancel all bookings
 ─▶ wait for VesselArrived ✉ (AddressChanged ✉ non-interrupting, 60s late ─ interrupting ─▶ notify ─▶ wait again)
 ─▶ plan a slot per container ☰ ─▶ confirm delivery per container ⦀ ─▶ damage? ─▶ invoice (⚡ ─▶ collect manually)
```

Pick *Door-to-door import* and a preset. Waiting messages appear in *Open work* with a **Send** button; that button
does what the carrier's or the customs system's webhook would do: `POST /api/messages {name, correlationKey, variables}`.

| Scenario (preset) | What to do and watch |
|---|---|
| Low risk, 3 containers | Bookings run in the sub-process: ocean and warehouse in parallel, then trucks. The call activity starts **customs-clearance v2** as a separate instance (click the link above the diagram). Its event-based gateway waits for three things at once. Send `CustomsCleared` there; back in the parent, send `AddressChanged` (the wait continues) and then `VesselArrived`. Slots are planned **one container after another**, then you get **one delivery task per container**. Tick *damaged* on one of them to see the claim branch |
| High value → compliance review | Wait 20s: a reminder runs **beside** the open review (non-interrupting). Wait 45s: the review is **cancelled** and the head of compliance gets the task (interrupting). Untick `cleared` to end via the terminate event |
| Embargoed origin | The XOR's third branch: refused before anything is booked |
| No warehouse | The warehouse rejects the booking **inside** the sub-process. The error boundary on the sub-process (not on the task) catches it and ends the parallel ocean branch. Compensation undoes **only** the ocean booking: trucks were never booked |
| Wait inside customs (any preset that reaches customs) | Do nothing for 30s: the child chases the broker and goes back to waiting (a loop through an XOR merge). At 40s the parent tells the customer that customs is slow, without interrupting the call |
| Cargo seized (low-risk preset) | In the child, send `InspectionOrdered`, then complete *Inspect the cargo* with `passed` unticked. The child throws `CARGO_SEIZED` from an error end event. Nothing in the child catches it, so the child ends `TERMINATED` and the error lands on the parent's call activity: trucks, warehouse and ocean are undone, newest first |
| Credit limit | Billing is last on purpose: by then the goods are delivered and there is nothing left to compensate. The rejected charge goes to a person instead (*Collect payment manually*) |

## 5. Versioning and migration

Process definitions change while instances are running. A clearance started last week must not jump into a diagram it
was never designed for. Real engines solve this the same way this one does:

| Concept | What it means here | Real-world equivalent |
|---|---|---|
| **Immutable versions** | Every deploy of a key with different XML creates the next version. XML that is already deployed (as *any* version) creates nothing new, so restarting doesn't add versions | Camunda 7 deployments, Zeebe process versions |
| **Instances stay put** | An instance runs on the version it started with until it ends or someone migrates it. The process list shows how many instances still run on each version (`v1 · 2026.1 · 2▶`) | same |
| **Version tag** | `mini:versionTag="2026.2"` on `<bpmn:process>`: a label people choose. Numbers are assigned by the engine and differ between environments; tags don't | `camunda:versionTag`, Zeebe `versionTag` |
| **Start a specific version** | `POST /api/processes/:key/start {variables, version}` or `{versionTag}`; the *Start* panel has a version picker | `startProcessInstanceById` |
| **Call activity binding** | `mini:calledElementBinding` = `latest` (newest at call time), `version` (exact number) or `versionTag`. The value may be an expression: import-shipment calls `${customsRelease}`, so one order can pin release 2026.1 while new orders get 2026.2 | `camunda:calledElementBinding`, Zeebe `bindingType` |
| **Diff** | `GET /api/processes/:key/diff?from=1&to=2`: nodes added, removed or changed between two versions | Camunda Modeler's diff |
| **Migration** | `POST /api/instances/:id/migrate {targetVersion, mapping, dryRun}` moves a running instance. Every token goes to the node with the same id in the target, or to `mapping[oldId]`. Nothing changes unless **all** tokens fit | Camunda 7 migration API, Camunda 8 Operate |
| **Batch migration** | `POST /api/processes/:key/migrate {fromVersion, targetVersion, mapping}` migrates every running instance of a version; each one succeeds or fails on its own | Camunda batch migration |

Migration refuses what it can't do safely: a node that doesn't exist in the target, a user task mapped to a different
kind of activity, a node in another sub-process, a join whose incoming flow disappeared, a handler that is running right
now. Waiting events, receive tasks and event-based gateways **may** change type, because their subscriptions can be
rebuilt from the new diagram. A timer that exists in both versions keeps its due time.

**Try it**: customs-clearance ships in two releases.
[v1 (2026.1)](processes/customs-clearance.v1.bpmn) waits for release in a **receive task**.
[v2 (2026.2)](processes/customs-clearance.v2.bpmn) replaces it with an **event-based gateway** that can also handle an inspection.

1. Start *Door-to-door import* with the preset **Pin customs release 2026.1**. The call activity starts customs **v1**.
   Open the child (link above the diagram).
2. *Versions & migration* shows the diff: `− Wait_Release`, `+ Gw_Decision`, … Click **Dry run** with an empty mapping `{}`:
   *v2 has no node "Wait_Release"*. The suggested mapping `{"Wait_Release": "Gw_Decision"}` is pre-filled. Dry run → OK.
3. **Migrate this instance**. The cockpit now draws v2. The token waits at the gateway with three new subscriptions,
   so the migrated instance can take the inspection path, which didn't exist when it started. The parent is unaffected.
4. Start a few customs-clearance v1 instances directly (version picker → v1) and use **Migrate all running v1**.

```bash
curl -X POST localhost:3200/api/instances/<id>/migrate -H 'content-type: application/json' \
     -d '{"targetVersion": 2, "mapping": {"Wait_Release": "Gw_Decision"}, "dryRun": true}'
```

## 6. Diagram vs code: compared with `apps/orchestrator`

| | Hand-coded orchestrator | BPMN engine |
|---|---|---|
| Where the flow lives | `SHIPMENT_SAGA` array + `SagaOrchestrator` loop | `shipment-saga.bpmn` |
| Changing the order of steps | Code change + redeploy | Redraw + deploy a new version |
| Branching, parallelism, human steps, timers | Write it yourself | Gateways, user tasks, timer events, ready to use |
| Timeouts (unknown outcome) | Compensates the timed-out step too | Incident: an operator decides (retry is safe thanks to idempotency) |
| Visibility | Custom UI built for this saga | Any process gets a cockpit for free |
| Cost | Plain code, easy to unit test, no new concepts | A platform to run and learn; logic split between diagram and handlers |

Neither one is "better". BPMN pays off when processes are long-running, involve people, change often, or must be explained to non-developers.
The import process shows where that line is: escalation timers, waiting for a vessel for weeks, a separately versioned
customs process and one task per container would each be a project of their own in the hand-coded orchestrator.

## 7. What real engines add (good exercises)

The engine is about 1,700 lines including comments, and it deliberately leaves things out. In rough order of difficulty:

1. **Message buffering**: Zeebe keeps a published message for its TTL, so it still correlates if the process gets to the receive task a moment later. Here a message nobody waits for is lost. Add a `messages` table with an expiry.
2. **Timer cycles** (`R3/PT10S`): a non-interrupting boundary that fires every 10s instead of once.
3. **Event sub-process**: a sub-process with `triggeredByEvent="true"` that starts when a message arrives anywhere in its scope ("customer cancels the order").
4. **Inclusive gateway (OR)**: forking is easy; the join is the classic hard problem (how does it know which branches will never arrive?).
5. **Migrating call-activity children** together with their parent, and migration plans that also rename variables.
6. **External task workers** (the Camunda 8/Zeebe model): instead of calling handlers in-process, the engine publishes jobs and workers poll `GET /jobs?type=ocean.book`, then `POST /jobs/:id/complete`.
7. **Optimistic locking**: add a `version` column and reject concurrent saves instead of the in-memory lock, so you can run two engine nodes.
8. **A durable outbox**: parent/child notifications live in memory until the next save (`afterSave`), and `resumeAfterRestart()` repairs what a crash loses. Store them in a table instead.
9. **History tables**: move `history` into its own table and build reporting (average time per task, where instances get stuck).
10. **A safe expression language**: replace the `new Function` in [expressions.ts](src/engine/expressions.ts) with FEEL or a small parser. Today, anyone who can deploy can run code on the server.

### Supported subset

Events: plain `startEvent`; `endEvent` (plain, terminate, error); timer and message `intermediateCatchEvent`;
compensation `intermediateThrowEvent`; error, compensation, timer and message `boundaryEvent` (timer and message
boundaries interrupting or not, on activities that wait).
Activities: `task`, `serviceTask`, `userTask`, `receiveTask`, embedded `subProcess`, `callActivity`, each optionally
multi-instance (parallel or sequential).
Gateways: `exclusiveGateway`, `parallelGateway`, `eventBasedGateway`.
Anything else (inclusive gateways, event sub-processes, script tasks, standard loops, message start events…) is refused
at deploy time with a clear message rather than silently ignored.

### Extension attributes (`mini:` namespace)

| Where | Attribute | Example |
|---|---|---|
| `process` | `versionTag` | `2026.2` |
| `serviceTask` | `handler` | `ocean.book` |
| `userTask` | `formFields` | `cleared:boolean,note:string` |
| `message` | `correlationKey` | `${shipmentRef}` |
| `callActivity` | `calledElementBinding`, `calledElementVersion`, `calledElementVersionTag`, `inputs`, `outputs` | `versionTag`, `${customsRelease}`, `shipment,shipmentRef` |
| `multiInstanceLoopCharacteristics` | `collection`, `elementVariable`, `outputCollection`, `outputElement` | `${containerList}`, `container`, `proofsOfDelivery`, `${slot}` |

### REST API

| Call | Purpose |
|---|---|
| `GET /api/processes` | every version of every process, with `versionTag` and `running` count |
| `POST /api/processes` `{xml}` | deploy (validates; returns the new or existing version) |
| `GET /api/processes/:key/xml?version=` | the BPMN of a version |
| `GET /api/processes/:key/diff?from=&to=` | node-level diff between versions |
| `POST /api/processes/:key/start` `{variables, version?, versionTag?}` | start an instance |
| `POST /api/processes/:key/migrate` `{fromVersion, targetVersion, mapping?, dryRun?}` | batch migration |
| `POST /api/messages` `{name, correlationKey?, variables?}` | correlate a message |
| `GET /api/instances`, `GET /api/instances/:id` | list / detail (incl. user tasks, subscriptions, called instances) |
| `POST /api/instances/:id/tasks/:tokenId/complete` `{variables}` | complete a user task |
| `POST /api/instances/:id/incidents/:tokenId/retry` | retry an incident |
| `PUT /api/instances/:id/variables` `{variables}` | replace variables |
| `POST /api/instances/:id/migrate` `{targetVersion, mapping?, dryRun?}` | migrate one instance |
| `POST /api/instances/:id/cancel` | cancel (also cancels the instances it called) |
