# SwingProAI — Launch Gates

## Status and Purpose

This document is the single canonical source of truth for SwingProAI's hard
launch requirements: what must exist, be tested, and be verified before the
product is considered ready to launch. `CLAUDE.md`'s existing "Mobile First
UI" directive (100% responsive, bottom-tab navigation under 768px, 44x44px
minimum touch targets) is the standing engineering rule requirement 1 below
implements — this document does not replace or duplicate that rule; it
sequences and gates the work required to satisfy it and the other eleven
requirements.

## Hard Launch Requirements

1. Robust responsive web platform.
2. Early mobile-formatted web testing.
3. Android APK for internal testing.
4. Android Play Store production release.
5. iPhone TestFlight build.
6. iPhone App Store production release.
7. Dedicated landscape-first iPad Coach Command Center.
8. iGolf course and scorecard integration.
9. Golf GPS MVP with front, center, and back distances.
10. Swing analysis and personalized reports.
11. Golfer progress, goals, bag, drills, and lessons.
12. Coach marketplace and coach-to-golfer workflows.

## Launch-Blocking Definition

The product is not considered launch-ready until all twelve requirements
above are completed and independently verified. Each requirement is binary
for the purpose of this document — done and verified, or not yet done —
partial progress on one requirement does not satisfy its gate.

## Early Responsive-Web Milestone

Responsive mobile web (requirement 1) is the first early-testing surface for
SwingProAI on phones and tablets, reachable through an ordinary browser well
before any native app-store artifact exists. It does not replace, satisfy,
or substitute for the Android, iPhone, or iPad release gates below — those
remain separate, subsequent requirements with their own distinct
verification.

## Android Gates

- Internal signed APK, distributed for internal testing (requirement 3).
- Android Play Store production release (requirement 4).

## iPhone and iPad Gates

- iPhone TestFlight build (requirement 5).
- iPhone App Store production release (requirement 6).
- Dedicated landscape-first iPad Coach Command Center (requirement 7) — a
  distinct, tablet-native coaching workspace, not merely the responsive web
  shell rendered at a larger size.

## iGolf and Golf GPS Gate

- Licensed iGolf course and scorecard integration (requirement 8).
- Golf GPS MVP (requirement 9) providing front, center, and back green
  distances.
- Supporting foundations: course search and selection, tee selection,
  scorecard, round start/resume/finish, hole navigation, location
  permission states, privacy/consent copy, and weak-signal/offline states.
  These may be prototyped against mocked provider data ahead of licensed
  iGolf access; real course and green-geometry data requires the licensed
  integration itself.

## Post-Launch Advanced Golf Features

The following remain post-launch enhancements, not hard launch gates:

- Advanced AI caddie.
- Automatic shot detection.
- 3D course maps.
- Green Heat Maps.

Foundation work for any of these may occur earlier than launch only through
its own separately authorized implementation slice — nothing in this
document authorizes that work by itself.

## Authorization Boundary

Recording a requirement in this document is not an authorization to perform
it. Every implementation slice, commit, push, pull request, merge, Supabase
schema or data action, domain/DNS change, app-store release, iGolf
activation, and production rollout remains its own separately authorized
action, requested and approved independently of this document.

## Sequencing

The approved high-level sequence:

1. Responsive web (requirement 1, RW1 onward).
2. Database/security completion where required.
3. Golfer personalization (requirements 10 and 11).
4. iGolf/course/scorecard foundation (requirement 8, foundation work).
5. Golf GPS MVP (requirement 9).
6. Android and iPhone device betas (requirements 3 and 5).
7. iPad Coach Command Center (requirement 7).
8. Controlled combined beta.
9. Public launch, after all hard gates above have passed.

Coach marketplace and coach-to-golfer workflows (requirement 12) proceed in
parallel with the golfer-facing sequence above, on their own authorized
implementation slices.
