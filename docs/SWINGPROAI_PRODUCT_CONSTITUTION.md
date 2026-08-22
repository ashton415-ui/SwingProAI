# SwingProAI Product Constitution

## Status and Authority

This document is the canonical source for SwingProAI's permanent product
direction, product principles, locked product pillars, premium-quality
standard, and long-term architectural intent. It exists so that the agreed
product vision cannot be silently lost, downgraded, reinterpreted, or replaced
across future sessions, contributors, implementation slices, or handoffs.

It is a direction document. It is not a status report, and it is not a work
order.

### Precedence

1. **This Constitution** governs permanent product direction and locked
   product pillars.
2. **`docs/LAUNCH_GATES.md`** remains the canonical source for hard
   launch-blocking requirements and launch sequencing. Where this Constitution
   describes a capability that also appears there as a launch requirement,
   `LAUNCH_GATES.md` governs whether and when it blocks launch. This document
   does not duplicate, renumber, or restate its twelve hard requirements.
3. **Subsystem rollout documents** — including
   `docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md`,
   `docs/COACH_MARKETPLACE_ROLLOUT.md`, and the security and migration
   documents in `docs/` — remain authoritative for their own scoped
   implementation contracts and their own recorded rollout status.
4. **Verified first-party evidence takes precedence over documentation** when
   determining *current* implementation state. Repository contents, database
   state, hosted-service state, and deployment records outrank any prose —
   including this document — about what exists today.

### When sources conflict

If authoritative documents materially conflict, do not silently pick an
interpretation, and do not quietly rewrite one to match the other. Stop,
surface the conflict, and resolve it through explicit authorization.

### Authorization boundary

Recording a requirement in this Constitution does **not** authorize its
implementation. Every implementation slice, database action, deployment,
native release, vendor activation, physical-product action, Git mutation, and
production rollout remains separately authorized, requested and approved
independently of this document.

Planned and future requirements must never be described as currently
implemented merely because they appear here. Throughout this document,
"required future capability", "planned", and "long-term target" mean exactly
that: agreed direction that is **not yet built**.

---

## North Star

SwingProAI is an intelligent golf-performance and learning platform that meets
golfers at their current level and helps them improve every facet of their
game — from fundamentals through advanced swing analysis, equipment
intelligence, launch-monitor optimization, professional coaching, practice,
and on-course performance.

**FROM TEE TO GREEN, WE'RE WITH YOU.**

SwingProAI must not be reduced to only a swing-video analyzer.

---

## A. Premium Product Standard

SwingProAI is a premium, professional-grade golf-performance platform.

Product work optimizes for:

- accuracy
- polish
- reliability
- structure
- scalability
- data integrity

A technically functioning feature is **not** fully done if it is knowingly:

- visibly cheap
- fragile
- misleading
- architecturally disposable
- inconsistent
- unreliable
- inaccessible where accessibility is relevant

"It works on the happy path" is a milestone, not a completion criterion.

---

## B. Evidence Standard and Anti-Hallucination Rules

The product must explicitly distinguish between these kinds of information,
and must carry that distinction through storage, presentation, and AI
reasoning:

| Evidence type | Meaning |
| --- | --- |
| Measured value | Directly captured or instrument-reported |
| User-entered information | Supplied by the golfer, unverified |
| Source/provenance-backed data | External or equipment data traceable to a cited source |
| Model observation | What a model detected in the input |
| AI inference | What a model concluded beyond direct observation |
| Coach-provided observation | Human professional judgement |
| Recommendation | Suggested action derived from the above |

Permanent rules:

- SwingProAI must never present unsupported inference as measured fact.
- SwingProAI must never fabricate precision because a value would be
  convenient, would fill a gap in a layout, or would make output look more
  complete.
- Where data is unavailable or confidence is insufficient, the product says
  so.
- Causal claims require evidence appropriate to the strength of the claim.
- Different evidence types must not be silently flattened into one
  undifferentiated "insight".

Project execution follows the same discipline:

```
inspect -> establish evidence -> implement -> test ->
independently verify -> publish -> independently verify
```

---

## C. The Web / Shared Platform Is the Current Foundation

Current web and shared-platform work remains the implementation foundation.

Engineering effort must **not** be redirected into native-mobile
implementation simply because native applications are constitutionally
required. Architecture built now should remain usable by future native
clients — that is the obligation this section creates, not an obligation to
start building those clients.

---

## D. Required Future Product Family

The permanent product family:

- **SwingProAI Web**
- **SwingProAI for Android** — required future capability
- **SwingProAI for iPhone** — required future capability
- **SwingProAI Coach Command Center for iPad** — required future capability

Android must eventually support signed distributable internal testing builds
such as APK, and production Play Store distribution. iPhone and iPad must
eventually support TestFlight and App Store production distribution.

None of these native applications exists today. See `docs/LAUNCH_GATES.md` for
which of them are launch-blocking and in what order.

---

## E. One Shared Platform, Several Clients

Do not create four disconnected SwingProAI products.

Prefer shared, server-authoritative domain logic for:

- authentication
- authorization
- entitlements
- subscriptions
- equipment intelligence
- AI analysis
- launch-monitor intelligence
- coaching
- golfer profile
- learning/education profile
- progress intelligence
- scoring/handicap data
- annotation and comparison data

Avoid burying durable business logic only inside Next.js UI components. Logic
that a future Android, iPhone, or iPad client will need must not be reachable
only through the web presentation layer.

---

## F. Mobile-Ready Now, Mobile Implementation Later

Current architecture should be reviewed for future native-client
compatibility.

The permanent native architecture is **deliberately not locked**. This
document does not select:

- Capacitor
- React Native
- Expo
- Swift-only
- Kotlin-only
- any other specific framework

That decision belongs to a separately authorized native architecture
investigation, made against then-current technical evidence.

Permanent rule:

> **SHARED CODE WHERE SENSIBLE. NATIVE CAPABILITY WHERE PREMIUM FUNCTIONALITY
> REQUIRES IT.**

Quality takes precedence over forcing every capability through a single
cross-platform abstraction. The iPad Coach Command Center in particular may
require deeper native Apple frameworks.

**Legacy artifact, recorded honestly:** the repository contains a Capacitor
configuration under the legacy `swingmaster-web/` tree. That tree is
documented elsewhere as a separate, secondary build that is not the canonical
application. The existence of that artifact does **not** establish the
canonical future mobile architecture, and must not be cited as though the
decision were already made.

---

## G. iPad Coach Command Center

The iPad product is **not** an enlarged iPhone interface. It is a premium,
landscape-first professional coaching workstation. This is a required future
capability; none of it is implemented today.

Required future capabilities:

- golfer selection
- dual side-by-side swing video
- current swing vs prior swing
- golfer vs golfer
- golfer vs coach/reference
- before vs after lesson
- different club
- different equipment
- different session
- synchronized playback
- synchronized scrubbing
- frame stepping
- manual synchronization
- golf-checkpoint synchronization
- AI-assisted synchronization, where sufficiently reliable
- analysis-to-analysis comparison
- coach notes
- assigned drills
- lesson/review creation
- golfer lesson delivery

---

## H. Dual-Video and Analysis Comparison

Where supported by validated analysis data, future comparison should support
metrics such as:

- spine angle
- hip rotation
- shoulder rotation
- tempo
- posture
- early extension
- swing plane
- sequencing
- shaft/club positions
- other validated swing metrics

Comparison presentation should be capable of showing, per metric:

- Swing A value
- Swing B value
- difference / change
- evidence-supported AI explanation

Do not manufacture a numerical comparison for metrics that were not actually
measured. An absent metric is reported as absent.

---

## I. Apple Pencil and the Golf Annotation Toolset

Apple Pencil support is a **locked product requirement** for the iPad Coach
Command Center, and a required future capability.

Planned core tools:

- freehand drawing
- straight line
- spine-angle line
- swing-plane line
- shaft line
- hip line
- shoulder line
- angle measurement
- circle/highlight
- text/label
- eraser

The product requirement is locked. The final technical implementation is
**not** locked by this document and requires its own architecture gate.

---

## J. Structured, Frame-Aware Annotations

Coach annotations must be stored as reusable structured data rather than only
being permanently burned into video pixels.

Architecture must anticipate association with:

- golfer
- coach
- video
- analysis
- timestamp/frame
- annotation type
- normalized geometry
- measured angle, where applicable
- label/comment
- metadata

The exact database schema is **not** locked here. Two properties are locked:
annotations should eventually render consistently across Web, Android, iPhone,
and iPad; and frame/time-linked annotations must remain associated with the
intended swing moment rather than drifting against playback.

---

## K. Coach and Golfer Workflow

The iPad Command Center must not become an isolated drawing utility. It is one
station inside a coach-to-golfer loop.

Long-term coach workflow:

```
open golfer -> review swing -> compare swings -> annotate ->
add observations -> assign drills -> create lesson/review -> save/deliver
```

Golfer-facing applications should eventually receive:

- marked-up frames
- analysis comparison
- explanation
- drills
- lesson plan
- coach feedback

---

## L. AI and Human Coaching

AI complements professional coaching; it does not silently replace it.

Architecture should allow these evidence sources to coexist without being
treated as equivalent:

- AI analysis
- coach observations
- coach annotations
- golfer history
- equipment data
- launch-monitor data
- practice data
- on-course data

A coach's judgement and a model's inference may disagree. The product must be
able to represent that, not resolve it by silently preferring one.

---

## M. Equipment Intelligence

Canonical equipment identity is a platform foundation.

Equipment should eventually flow consistently through:

- My Bag
- Analyze
- Telemetry
- launch-monitor sessions
- progress history
- coach review
- future native clients

Future comparisons may reason about equipment changes only where supported by
actual data.

Foundation work on the canonical equipment catalog has already begun through
its own separately gated slices; `docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md`
remains authoritative for what has and has not been applied. This Constitution
is deliberately not an implementation-status ledger.

---

## N. Launch-Monitor Intelligence

Launch-monitor data is not an isolated spreadsheet or import feature.

Long-term intelligence target:

```
video + validated swing analysis + equipment +
launch-monitor measurements + golfer history
```

AI interpretation and causal language across those sources must respect the
evidence and confidence boundaries in section B.

---

## O. Longitudinal Progress Intelligence

SwingProAI must understand golfer development over time rather than merely
accumulating disconnected analyses.

Future structured history should support comparison across:

- swings
- metrics
- equipment
- launch-monitor sessions
- coaching
- drills
- practice
- rounds
- scoring/handicap

---

## P. AI-Guided Onboarding

Adaptive AI-guided onboarding is a required product pillar and a required
future capability.

New golfers should eventually be assessed conversationally across:

- playing experience
- playing ability
- golf knowledge
- handicap familiarity
- typical scoring
- practice frequency
- playing frequency
- goals
- strengths
- weaknesses
- equipment familiarity
- launch-monitor familiarity
- coaching experience
- desired improvement areas

The experience must adapt. Do not give every golfer the same static
questionnaire.

---

## Q. Playing Ability Is Not Golf Knowledge

Maintain two distinct concepts: **playing ability** and **golf knowledge**.

Do not assume that a high handicap means technically uninformed, and do not
assume that a low handicap means the golfer understands every swing,
equipment, or launch-monitor concept. Either combination is common and the
product must serve all of them.

---

## R. Beginner-to-Expert Education

SwingProAI should teach without patronizing beginners, and without forcing
experts through beginner explanations.

Contextual education should eventually be able to answer:

- What is this?
- Why does this matter?
- What does this mean for my game?
- What is an appropriate interpretation for my level?
- How can I improve it?

---

## S. Required Educational Coverage

Permanent educational coverage includes at minimum:

- handicap
- Handicap Index
- Course Rating
- Slope Rating
- ball flight
- launch
- backspin
- spin axis and curvature concepts, where accurately represented
- club path
- face angle
- equipment fundamentals
- driver optimization
- iron play
- wedge play
- putting
- course management
- practice strategy
- launch-monitor metrics
- SwingProAI metrics

Education is subject to section B: teach what is established, and do not
present contested or oversimplified mechanics as settled fact.

---

## T. SwingProAI Learn

A future adaptive learning system is required.

Educational progression should support:

```
UNDERSTAND -> APPLY -> PERSONALIZE -> IMPROVE -> TRACK
```

Content should be surfaced according to golfer needs rather than forcing every
golfer through one curriculum.

---

## U. Personalized Starting Improvement Plan

Onboarding should eventually deliver immediate personalized value rather than
ending only with "setup complete."

It should establish an initial golfer profile and recommended first actions,
and that profile must be capable of evolving as the golfer develops.

---

## V. Tee-to-Green Framework

Permanent product philosophy:

**FROM TEE TO GREEN, WE'RE WITH YOU.**

The platform should ultimately help the golfer across:

- tee game
- approach play
- short game
- putting
- course management
- scoring
- handicap
- practice
- equipment
- coaching
- progress

SwingProAI must not be reduced to only swing-video analysis.

---

## W. Tee-to-Green Development View

Future progress intelligence should be capable of organizing development
across areas such as:

- Tee Game
- Approach Game
- Short Game
- Putting
- Swing Mechanics
- Course Performance

Do **not** invent unsupported universal or gimmicky "AI scores." Any aggregate
development score must be evidence-based and transparently defined, with its
inputs and limits stated.

---

## X. Coach-Linked Education

Future coaching architecture should allow coaches, where appropriate, to:

- influence educational depth
- recommend educational modules
- connect teaching concepts to assigned drills or lessons

This remains future functionality.

---

## Y. Cross-Device Golfer Profile

One golfer has one shared identity, one learning profile, and one performance
history.

Do not create duplicate device-specific onboarding identities or profiles for
Web, Android, iPhone, or iPad.

---

## Z. Scoring, Handicap, and GPS

On-course performance remains a permanent platform pillar.

Planned areas:

- round history
- scoring
- handicap-related tracking
- course data
- GPS/course intelligence
- course management
- progress correlation

Vendor, provider, and API selection remains separately gated. See
`docs/LAUNCH_GATES.md` for the hard launch requirements covering course and
scorecard integration and the Golf GPS MVP.

---

## AA. Subscription Tiers and AI Depth

Par / Birdie / Eagle tier-aware analysis remains part of the permanent product
direction.

Long-term entitlement and model routing must be **server-authoritative**, not
merely presentation-level. A client must not be the thing that decides what a
golfer is entitled to.

Exact future model selection remains separately gated and must be based on
then-current validated model availability, capability, cost, and policy.

---

## AB. Coach Marketplace

Coach discovery, public profiles, booking, availability, and reviews remain
planned platform pillars.

The marketplace should build on a proven coach-golfer workflow rather than
becoming an isolated directory. See `docs/COACH_MARKETPLACE_ROLLOUT.md` for
the scoped implementation contract.

---

## AC. SwingProAI Physical Starter Kit

Physical products are a future commercialization and product-ecosystem pillar.

A future SwingProAI Starter Kit may include:

- premium branded ball marker
- portable swing-recording phone tripod
- phone mount
- wireless/Bluetooth recording remote
- quick-start capture guide
- QR/NFC onboarding entry point

**Physical-product rule:** a SwingProAI physical product must improve use of
SwingProAI, improve the golfer or coaching experience, or meaningfully
reinforce the premium brand. Do not turn SwingProAI into an unrelated
merchandise store.

Supplier choice, pricing, subscription bundling, inventory, fulfillment, and
unit economics remain separately evaluated future decisions.

---

## AD. Future Coach Capture Kit

A later professional kit may include:

- heavier/pro tripod
- professional phone mount
- recording remote
- alignment/reference aids
- iPad stand
- Command Center accessories
- coach carrying case

This future commercial work must not distract from the current software
critical path.

---

## AE. Physical and Digital Onboarding

Future Starter Kit onboarding should be capable of guiding:

- account creation
- golfer profile setup
- equipment setup
- proper face-on camera positioning
- proper down-the-line camera positioning
- baseline swing capture

Future computer-vision framing and camera-position guidance may be considered
only where sufficiently reliable. Unreliable automatic framing guidance is
worse than none.

---

## AF. Premium UX Definition of Done

Where relevant, feature completion includes consideration of:

- loading states
- empty states
- error states
- permissions
- mobile responsiveness
- accessibility
- touch targets
- copy quality
- visual consistency
- authentication edge cases
- performance
- data integrity
- failure recovery
- cross-device consistency where applicable

---

## AG. No Scope Drift

Individual implementation slices remain narrowly scoped.

- This Constitution is **not** blanket implementation authorization.
- A future requirement appearing here does not permit implementing it early.
- Difficulty is not permission to silently downgrade a locked requirement.
- Material removal or weakening of a permanent product pillar requires
  explicit discussion and authorization.

If a locked requirement turns out to be impractical, that is a conversation to
have — not a reason to quietly ship a smaller version of it.

---

## Planning Order

High-level planning order for the pillars above:

1. current web/shared-platform hardening
2. separately gated Slice-2 database migration application
3. canonical equipment consumer migration: My Bag → Analyze → Telemetry →
   cross-surface consistency
4. tier-aware / deep AI analysis
5. launch-monitor normalization and fusion
6. coach/golfer workflow
7. coach marketplace expansion
8. scoring / handicap / GPS
9. unified longitudinal progress intelligence
10. beta hardening / production readiness
11. AI-guided onboarding and education, integrated at the appropriate
    architecture and product phase rather than lost
12. native-mobile architecture investigation
13. Android and iPhone applications
14. iPad Coach Command Center
15. physical Starter Kit and Coach Capture Kit commercialization, after
    software product value, supplier quality, economics, and fulfillment are
    validated

**This planning order does not override `docs/LAUNCH_GATES.md` regarding what
blocks launch.** `LAUNCH_GATES.md` remains authoritative for hard launch
requirements and launch sequencing.

Dependencies may legitimately change this planning order. No permanent product
pillar may be silently removed from it.

---

## Current Critical Path

Codifying future product pillars does not redirect current implementation.

After this documentation slice, the planned engineering critical path returns
to:

1. separately gated Slice-2 migration application
2. canonical equipment consumer migration
3. My Bag
4. Analyze
5. Telemetry
6. cross-surface equipment consistency
7. deeper / tier-aware AI work

**No native mobile, iPad, Apple Pencil, AI-onboarding, launch-monitor, or
physical-product implementation begins as a result of this document.**
