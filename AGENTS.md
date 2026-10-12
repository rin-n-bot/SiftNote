# SiftNote

Android-first Expo / React Native notes app.

## Sources of Truth

- `overview/PRD.md` — product behavior and MVP scope
- `overview/UI_REFERENCE/` — approved visual direction
- `overview/DECISIONS.md` — established architecture

The PRD wins if references conflict.

Core loop:

**Write → Highlight → Review**

Do not add features or redesign established UI unless requested.

## Engineering

Build the simplest correct implementation that satisfies the PRD.

Use current, supported, idiomatic Expo / React Native patterns.

Prefer:

- direct, readable code
- strict TypeScript
- focused components
- localized state
- few dependencies
- lightweight render and interaction paths
- existing project patterns

Avoid:

- unnecessary abstractions or layers
- speculative architecture
- unnecessary caching or memoization
- unnecessary providers or global state
- duplicated state
- unnecessary effects
- expensive work during render, typing, scrolling, or navigation
- solving hypothetical future problems

Keep persistent user data safe, but do not build elaborate recovery systems without a real requirement.

Prefer removing complexity over adding infrastructure.

## Code Organization

Keep code conventionally organized and easy to read.

- Keep components focused on clear responsibilities.
- Keep render code declarative and easy to scan.
- Move non-UI persistence/domain logic out of UI when practical.
- Prefer named helpers over complex inline logic.
- Extract components or hooks only when it improves clarity or reuse.
- Do not split code merely to reduce file length.
- Use the project's Prettier configuration.

## Expo / Native

Use installed versions and supported APIs.

Prefer existing Expo capabilities before adding dependencies.

Ask before:

- adding a native dependency
- changing native configuration that requires a new development build
- rebuilding the development APK

Never automatically run:

- `expo prebuild`
- `expo run:android`
- native project generation
- native rebuild commands
- EAS builds

Use Expo Router only.

Routes belong in:

`src/app/`

## Android

Android is the primary target.

Use normal Android behavior for:

- system Back
- keyboard
- focus
- text selection
- touch feedback
- system bars
- safe areas
- scrolling
- font/display scaling
- accessibility
- foreground/background lifecycle

The user performs visual and interaction testing on a physical Android device.

Do not claim visual correctness, smoothness, FPS, keyboard behavior, or native interaction quality unless actually observed.

### Native UX

Prefer native platform behavior and existing Expo / React Native primitives whenever practical.

- Use native navigation transitions and lifecycle behavior.
- Do not recreate native interactions with custom JavaScript animations when the platform already provides them.
- User input should receive immediate native feedback.
- Navigation should begin immediately when practical.
- Do not unnecessarily block screen transitions on database work, parsing, editor setup, persistence, or other nonessential work.
- Screens should appear as one coherent native transition.
- Avoid headers, controls, editor content, or other major UI sections visibly appearing later than the rest of the screen.
- Preserve native Back, keyboard, focus, selection, scrolling, touch feedback, and accessibility behavior.
- Avoid artificial loading states, delays, animations, or skeletons used only to hide implementation latency.
- Use custom interaction behavior only when required by the PRD or SiftNote's visual identity.

For the existing WebView editor, make the native/WebView boundary as unnoticeable as practical.

Do not repeatedly perform expensive editor initialization when existing valid runtime/state can be safely reused.

## Performance

Keep interaction-critical paths lightweight.

Prioritize:

1. note opening
2. note creation
3. Back navigation
4. editor typing
5. editor scrolling
6. Notes/Highlights scrolling
7. selection/highlighting
8. startup

User input should produce immediate feedback.

Do not perform unnecessary work during:

- render
- navigation
- note opening/creation
- typing
- scrolling
- selection/highlighting

Do not block interaction on work that can safely happen before, after, or concurrently with the native transition.

Prefer removing unnecessary work over adding optimization infrastructure.

Measure a real problem before adding:

- caching
- memoization
- preloading
- profiling infrastructure
- performance-specific abstractions

Persistent data remains the source of truth.

## Validation

For meaningful code changes run:

`npx expo lint`

`npx tsc --noEmit`

Run tests only when they directly apply to changed behavior.

Run:

`npx expo-doctor`

only when dependencies or Expo/native configuration change.

Never claim a command or test was run if it was not.

## Task Discipline

Do only the work required for the current request.

Do not create or update:

- documentation
- Markdown reports
- audits
- QA checklists
- plans
- progress logs
- implementation summaries
- architecture notes

unless explicitly requested.

Do not create files just to record what was done.

Do not run broad or unrelated commands.

Do not run:

- dependency audits
- exports
- builds
- EAS builds
- prebuilds
- native rebuilds
- unrelated test suites
- profiling/instrumentation

unless the current task genuinely requires them or the user explicitly asks.

Prefer modifying existing code over creating new abstractions, utilities, services, documentation, or infrastructure.

Do not add dependencies, caches, services, managers, providers, helper layers, or performance systems merely because they may be useful later.

Keep final reports brief.

## Rule

**Make SiftNote work well before making its architecture sophisticated.**