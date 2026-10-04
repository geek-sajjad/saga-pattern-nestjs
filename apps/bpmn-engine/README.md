# Mini BPMN: a BPMN tool built on bpmn-engine

A small BPMN tool built for learning. It runs the same freight-forwarding saga as `apps/orchestrator`, except this time
the flow is a **diagram** and a generic **engine** runs it. The orchestrator hand-codes that flow in TypeScript.

The engine is [bpmn-engine](https://github.com/paed01/bpmn-engine) (MIT), an open-source BPMN 2.0 execution engine for
Node.js. This app adds what every product built on a BPMN library has to add itself: deployments and versions,
persistence across restarts, service tasks wired to code, incidents, message correlation, call activities across
process versions, and saga-style compensation.

```
npm run start:participants      # the 5 services the saga talks to (terminal 1)
npm run start:bpmn              # the BPMN tool (terminal 2)
open http://localhost:3200/
```

Port: `BPMN_PORT` (default 3200). State: `data/bpmn-engine.sqlite` (`npm run db:reset` wipes it).

> Coming from the hand-written engine (commit `d2d16b0`)? Its saved instances use a different format.
> Run `npm run db:reset` once before starting.

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
| **Engine** | Parse the XML, run *instances* of it, persist their state, call your code | `bpmn-engine` + [src/engine/](src/engine/) | Camunda 7/8 (Zeebe), Flowable |
| **Cockpit** | See running instances, complete human tasks, fix failures | *Cockpit* tab | Camunda Operate / Tasklist / Cockpit |

```
  Modeler ──(deploy XML)──▶ Engine ──(calls)──▶ your code (handlers) ──▶ ocean-carrier, customs, …
  bpmn-js                   bpmn-engine                                 (the existing TCP services)
     ▲                      + src/engine
     │                      │  ▲
     │                      ▼  │ complete task / retry / send message
  .bpmn file           SQLite  Cockpit
```

Both libraries come from the same family: bpmn-js draws with **bpmn-moddle**, and bpmn-engine parses with bpmn-moddle
too. The modeler and the engine can never disagree about what a file means.

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
  The `mini:` schema is registered with bpmn-moddle ([src/engine/mini-moddle.ts](src/engine/mini-moddle.ts)), so
  `mini:handler="ocean.book"` arrives in the engine as a plain `handler` property of the service task.

## 3. How the engine works

### Token passing (what bpmn-engine does)

The whole engine rests on one idea, which you can watch in the cockpit: **a process instance holds tokens, and each token
sits on a node.** bpmn-engine moves the tokens and runs each node's behaviour:

| Element | Symbol | Behaviour |
|---|---|---|
| Start event | ○ | Move along the outgoing flow |
| Service task | ▢⚙ | Run the handler code, merge its result into the variables, move on |
| User task | ▢👤 | **Wait state.** Park the token until a person completes the task in the cockpit |
| Receive task | ▢✉ | **Wait state.** Park the token until a matching message arrives (`POST /api/messages`) |
| Timer / message catch event | ◎🕒 ◎✉ | **Wait state.** Park the token until the duration (`PT15S`) passes or the message arrives |
| Exclusive gateway (XOR) | ◇ | Take the **first** outgoing flow whose condition is true, else the `default` flow |
| Parallel gateway (AND) | ◇+ | **Fork:** one token per outgoing flow. **Join:** wait until a token arrived on *every* incoming flow, then merge them |
| Event-based gateway | ◇⬠ | **Race.** Wait for every event after it (messages, timers); the first one to happen wins, the others are dropped |
| Sub-process | ▭ around a graph | Run the graph inside it; when the last token inside ends, continue |
| Call activity | ▢ thick border | Start a **separate instance** of another process (the version picked by its binding) and wait until it ends |
| Multi-instance activity | ▢ ⦀ or ☰ | Run the activity once per item of a list, in parallel (⦀) or one after another (☰); collect the results |
| Error boundary event | ⚡ on an activity | If the activity (or anything inside it) throws that BPMN error, abandon it and continue from here |
| Timer / message boundary event | 🕒 ✉ on an activity | While the activity waits: **interrupting** (solid) cancels it and continues here; **non-interrupting** (dashed) starts an extra token here and keeps the activity waiting |
| Compensation throw event | ⏪ | Run the compensation handlers of the **completed** activities in **reverse order** |
| End event | ● | Consume the token. No tokens left = the instance is `COMPLETED` |
| Terminate end event | ◉ | Remove every other token of its scope |
| Error end event | ⓧ | Throw a BPMN error. It travels outwards: enclosing sub-processes, then the calling process |

bpmn-engine runs all of this **in memory**, as a message broker inside your process: every element publishes events
(`activity.wait`, `activity.end`, `flow.take`, …) and reacts to messages (`signal`, `discard`, …).

### The platform around it (what src/engine adds)

An in-memory engine is not yet a BPMN *tool*. [bpmn-engine.service.ts](src/engine/bpmn-engine.service.ts) wraps it:

```ts
// one bpmn-engine Engine per running instance
const engine = new Engine({
  source: xml,                                   // the deployed version this instance runs on
  moddleOptions: { mini: MINI_MODDLE },          // so mini:handler & co. survive parsing
  expressions: libraryExpressions(…),            // ${…} is JavaScript over our process variables
  extensions: { mini: (activity) => … },         // every service task calls its mini:handler
  elements: { CompensateEventDefinition: … },    // our compensation (see below)
});
await engine.execute({ listener });              // every event → history, waits, then save
// …after every burst of events:
row.engineState = await engine.getState();       // bpmn-engine's snapshot: tokens, timers, loop counters
// …on boot, for every RUNNING row:
new Engine(options).recover(row.engineState).resume({ listener });
```

| Concept | What it means | Where |
|---|---|---|
| **Definition vs instance** | The deployed diagram is a *class*, each run of it is an *object* with its own tokens and variables | [entities.ts](src/engine/entities.ts) `Deployment`, `ProcessInstance` |
| **Versioning** | Deploying the same process key again creates **v2**. Running instances stay on the version they started with, and the cockpit draws that exact version. See [section 5](#5-versioning) | `deploy()`, `model(key, version)` |
| **Persistence & restarts** | After each burst of events the instance row gets bpmn-engine's `getState()` snapshot. On boot every `RUNNING` row is restored with `recover()` + `resume()`. Timers keep their original due time | `persist()`, `resume()` |
| **Events → our bookkeeping** | bpmn-engine reports through a listener. We turn its events into the audit trail and into `waits`: what the instance is busy with (user tasks, messages, timers, joins, calls), so the cockpit and the REST API don't have to understand the snapshot | `onEngineEvent()`, `Wait` |
| **Process variables** | The data travelling with the instance. They live in **our** row, not in bpmn-engine's scoped environments: handlers read them and return changes, and the expression resolver evaluates conditions against them | `variables`, [expressions.ts](src/engine/expressions.ts) |
| **Handlers (glue code)** | An *extension* gives every service task a `Service` that calls the `mini:handler` from the registry. The diagram says *what* happens and in which order; handlers say *how* | `handlerService()`, [freight-handlers.ts](src/handlers/freight-handlers.ts) |
| **Business error vs technical error** | `throw new BpmnError(code)` is an outcome the *diagram* handles: bpmn-engine routes it to the error boundary event with that `errorCode`. Any other exception is an **incident** | [handlers.ts](src/engine/handlers.ts), `runHandler()` |
| **Incidents & retry** | "trucking is down" isn't a business outcome, so it isn't drawn. We simply don't complete the service task: it stays parked (across restarts too) until someone fixes the cause and clicks *Retry*, optionally after editing variables | `incident()`, `retryIncident()` |
| **At-least-once execution** | If the engine stops while a handler runs, bpmn-engine executes the task again after `resume()`, so handlers must be idempotent (the participants key everything by `sagaId` = instance id) | `runHandler()` |
| **Messages & correlation** | A waiting message event *subscribes* with a correlation key evaluated at that moment (`${shipmentRef}` → `IMP-1A2B3C`). `POST /api/messages` finds the instance with a matching wait and signals bpmn-engine with the `<bpmn:message>` id. No buffering: a message nobody waits for is dropped | `subscribe()`, `correlateMessage()` |
| **Call activity** | bpmn-engine can only call processes from the same file, so it emits `activity.call` and waits. We start a **separate instance** of the called process (version chosen by `mini:calledElementBinding`), then signal the call activity when the child completes, or send it the child's uncaught error | `onCallActivity()`, `onChildEnded()` |
| **Multi-instance** | bpmn-engine runs one iteration per item of `mini:collection`. Each iteration sees its item (`mini:elementVariable`) and `loopCounter`; its result goes into the loop's output (`mini:outputCollection`), not into the process variables, so parallel iterations don't overwrite each other | `localsOf()`, `activity.end` |
| **Compensation (BPMN's built-in saga)** | Each forward task has a compensation boundary event ⏪ linked (dotted *association*) to its undo task. The throw event undoes completed tasks in reverse; already-undone ones are skipped on retry | `compensate()` |
| **Parsing & validation** | Deployment rejects diagrams this app can't run (service tasks without a handler, XOR flows without conditions, script tasks, …) before bpmn-engine ever sees them | [process-model.ts](src/engine/process-model.ts) |

### Where we changed bpmn-engine's behaviour (and why)

Using a library means accepting its semantics, or replacing a piece deliberately. Four places where this app does:

1. **Compensation.** bpmn-elements' compensation only reaches activities in the scope that throws it, and starts all undo
   tasks at once. The import process throws compensation *outside* the sub-process that booked things, and a saga
   should undo newest first, one step at a time, with an incident if an undo fails. So the app swaps in its own
   `CompensateEventDefinition` (`compensationBehaviour()`): the throw event runs the undo handlers from our list of
   completed activities, and only then lets the token continue.
2. **Real parallelism.** bpmn-engine really runs both branches of a parallel gateway at the same time. When the
   warehouse rejects while the ocean booking is still in flight, the sub-process is interrupted, **but the ocean
   carrier still books the vessel**. A handler that finishes after its task was interrupted is therefore still recorded
   as completed, and compensation waits for in-flight handlers before deciding what to undo. Try *No warehouse* in the
   import process and look for "finished after the task was interrupted" in the history.
3. **Uncaught error end events.** bpmn-engine simply ends the process. Here the instance ends as `TERMINATED`, and a
   called instance hands its error to the calling process's call activity (`CARGO_SEIZED`).
4. **Expressions.** bpmn-engine's default expressions only resolve paths (`${environment.variables.quote.amount}`),
   without operators. The app plugs in a resolver where `${quote.amount > 10000}` is JavaScript over the process
   variables, so the diagrams keep the short form.

## 4. Things to try

**Shipment saga** ([processes/shipment-saga.bpmn](processes/shipment-saga.bpmn)): use the presets in *Start an instance*.

| Preset | What you'll see |
|---|---|
| Happy path | 5 green tasks → "Shipment booked" |
| Customs rejects / No warehouse / Credit limit | Red ⚡ on the failing task → "Undo completed bookings" → orange undo tasks, **only for tasks that completed**, newest first |
| Timeout → incident | Trucking commits but replies too late, so you get a red incident (*outcome unknown*). Click **Edit** on the variables, delete `"simulate"`, save, then **Retry**. Trucking returns the booking it already made (idempotency) and the saga finishes |
| Flaky compensation → incident | Customs' undo fails twice: two incidents on the compensation event. Retry twice: warehouse and trucking are **not** undone again |
| *Stop a participant* (Ctrl+C), start a saga | Incident "not running (ECONNREFUSED)". Start it again, Retry |
| *Stop the BPMN tool* while an instance waits for a timer or has an incident, start it again | The instance continues: the timer fires at its original time, the incident is still there |

**Quote approval** ([processes/quote-approval.bpmn](processes/quote-approval.bpmn)):

- *Small quote*: the XOR takes the default "no" flow and skips approval. Then the AND gateway forks: "Notify sales" finishes immediately, while "Customer signs contract" waits. Watch the join show *waiting* until you complete the form, then the 15 s timer.
- *Big quote*: complete "Manager approves quote" with `approved` unticked to take the rejection path.

**Change a process without touching TypeScript:**

1. *Open in modeler* → shipment saga. Drag "Book trucks" after "Reserve warehouse space" (reconnect the arrows).
2. **Deploy**. You get **v2**. Old instances still show v1 in the cockpit; new ones run the new order.
3. Try deploying something broken (a service task without `mini:handler`) and read the engine's validation errors.
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
| No warehouse | The warehouse rejects the booking **inside** the sub-process. The error boundary on the sub-process (not on the task) catches it and interrupts the parallel ocean booking, which still completes at the carrier. Compensation undoes **only** the ocean booking: trucks were never booked |
| Wait inside customs (any preset that reaches customs) | Do nothing for 30s: the child chases the broker and goes back to waiting (a loop through an XOR merge). At 40s the parent tells the customer that customs is slow, without interrupting the call |
| Cargo seized (low-risk preset) | In the child, send `InspectionOrdered`, then complete *Inspect the cargo* with `passed` unticked. The child throws `CARGO_SEIZED` from an error end event. Nothing in the child catches it, so the child ends `TERMINATED` and the error lands on the parent's call activity: trucks, warehouse and ocean are undone, newest first |
| Pin customs release 2026.1 (v1) | The call activity binds by version tag, so this order runs the **older** customs process (a receive task instead of the event-based gateway), while new orders get 2026.2 |
| Credit limit | Billing is last on purpose: by then the goods are delivered and there is nothing left to compensate. The rejected charge goes to a person instead (*Collect payment manually*) |

## 5. Versioning

Process definitions change while instances are running. A clearance started last week must not jump into a diagram it
was never designed for. Real engines solve this the same way this one does:

| Concept | What it means here | Real-world equivalent |
|---|---|---|
| **Immutable versions** | Every deploy of a key with different XML creates the next version. XML that is already deployed (as *any* version) creates nothing new, so restarting doesn't add versions | Camunda 7 deployments, Zeebe process versions |
| **Instances stay put** | An instance runs on the version it started with until it ends. The process list shows how many instances still run on each version (`v1 · 2026.1 · 2▶`) | same |
| **Version tag** | `mini:versionTag="2026.2"` on `<bpmn:process>`: a label people choose. Numbers are assigned by the engine and differ between environments; tags don't | `camunda:versionTag`, Zeebe `versionTag` |
| **Start a specific version** | `POST /api/processes/:key/start {variables, version}` or `{versionTag}`; the *Start* panel has a version picker | `startProcessInstanceById` |
| **Call activity binding** | `mini:calledElementBinding` = `latest` (newest at call time), `version` (exact number) or `versionTag`. The value may be an expression: import-shipment calls `${customsRelease}`, so one order can pin release 2026.1 while new orders get 2026.2 | `camunda:calledElementBinding`, Zeebe `bindingType` |
| **Diff** | `GET /api/processes/:key/diff?from=1&to=2`: nodes added, removed or changed between two versions. The cockpit's *Versions* panel shows it | Camunda Modeler's diff |

customs-clearance ships in two releases: [v1 (2026.1)](processes/customs-clearance.v1.bpmn) waits for release in a
**receive task**; [v2 (2026.2)](processes/customs-clearance.v2.bpmn) replaces it with an **event-based gateway** that can
also handle an inspection. Start an import with *Pin customs release 2026.1* and compare the two versions in the child's
*Versions* panel.

**What about migrating running instances?** Camunda can move a running instance to a newer version (map old node ids
to new ones). bpmn-engine has no such feature: its snapshot is an internal format, and rewriting it would break with
every library upgrade. So instances here finish on the version they started with, which is also the safe default in
real engines. See exercise 4 below.

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

## 7. What real platforms add (good exercises)

bpmn-engine does the BPMN semantics; the platform around it is about 1,300 lines including comments. In rough order of difficulty:

1. **Message buffering**: Zeebe keeps a published message for its TTL, so it still correlates if the process gets to the receive task a moment later. Here a message nobody waits for is lost. Add a `messages` table with an expiry.
2. **History tables**: move `history` into its own table and build reporting (average time per task, where instances get stuck).
3. **A safe expression language**: replace the `new Function` in [expressions.ts](src/engine/expressions.ts) with FEEL or a small parser. Today, anyone who can deploy can run code on the server.
4. **Instance migration**: move a waiting instance to a newer version, for the easy case (every token waits at a node that exists in both versions): start the new version's engine, `recover()` the old snapshot into it, and check what breaks.
5. **External task workers** (the Camunda 8/Zeebe model): instead of calling handlers in-process, publish jobs; workers poll `GET /jobs?type=ocean.book`, then `POST /jobs/:id/complete`.
6. **A durable outbox**: "child ended, tell the parent" happens in memory; a crash at the wrong moment is only repaired when the parent resumes. Store these notifications in a table instead.
7. **More than one engine node**: every running instance lives in one Node.js process. Running two nodes needs a lease per instance (who runs it) and optimistic locking on the row.

### Supported elements

bpmn-engine supports most of BPMN 2.0 ([bpmn-elements](https://github.com/paed01/bpmn-elements)). The sample diagrams use:

Events: plain `startEvent`; `endEvent` (plain, terminate, error); timer and message `intermediateCatchEvent`;
compensation `intermediateThrowEvent`; error, compensation, timer and message `boundaryEvent` (interrupting or not).
Activities: `task`, `serviceTask`, `userTask`, `receiveTask`, embedded `subProcess`, `callActivity`, each optionally
multi-instance (parallel or sequential).
Gateways: `exclusiveGateway`, `parallelGateway`, `eventBasedGateway`.

Deployment refuses `scriptTask`, `sendTask`, `businessRuleTask` (no `mini:handler` for them), `transaction`,
`adHocSubProcess`, `complexGateway` and standard loops. Other elements bpmn-engine knows (inclusive gateways, event
sub-processes, signal and escalation events, timer cycles) are accepted but not exercised by the samples.

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
| `POST /api/messages` `{name, correlationKey?, variables?}` | correlate a message |
| `GET /api/instances`, `GET /api/instances/:id` | list / detail (incl. tokens, user tasks, subscriptions, called instances) |
| `POST /api/instances/:id/tasks/:tokenId/complete` `{variables}` | complete a user task |
| `POST /api/instances/:id/incidents/:tokenId/retry` | retry an incident |
| `PUT /api/instances/:id/variables` `{variables}` | replace variables |
| `POST /api/instances/:id/cancel` | cancel (also cancels the instances it called) |

Token ids are bpmn-engine's execution ids (e.g. `Task_Approve_c485281a71`).
