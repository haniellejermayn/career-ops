# Design System

## Direction

Career-Ops uses a quiet, information-first workspace inspired by the supplied `career-ui/theme.html`. The interface should feel like a well-organized local record, not an analytics dashboard. One centered reading surface, clear horizontal navigation, compact tables, and thin rules provide structure.

## Color

- Ink: `#1a1a2e`
- Secondary ink: `#3d3d56`
- Muted ink: `#606077`
- Paper: `#fafaf7`
- Secondary paper: `#f5f4ef`
- Rule: `#e2e1da`
- Primary action: `#2d6a8e`
- Positive: `#277a45`
- Negative: `#b83228`

Color is semantic. Blue marks actions and current navigation, green confirms success, red communicates errors or terminal negative states, and neutral paper tones carry the rest of the interface.

## Typography

Use IBM Plex Sans when available, with Segoe UI and Arial as local fallbacks. Use IBM Plex Mono or Consolas for counts, file paths, and compact machine-readable labels. Headings rely on weight and modest scale rather than oversized display type.

## Layout and components

- Content width is capped at 1120px with 24px desktop gutters and 16px mobile gutters.
- Primary navigation is a horizontal tab row under the product name.
- Tables use a strong header rule and light row rules. Avoid container cards around tables.
- Forms use one or two columns based on field relationships, collapsing to one column on narrow screens.
- The primary surface is one horizontally scrollable, spreadsheet-like tracker table. Status is edited inline.
- Dialogs are reserved for adding/editing a row and confirming row deletion.
- Controls use small corner radii, visible borders, and direct verb-object labels.
- Empty states are plain text with one relevant action.

## Interaction

Keyboard focus must be visible. Validation errors appear inside the affected form and may also use the global toast. Form values are captured before controls enter the busy state. Motion is limited to short color transitions and is removed for reduced-motion preferences.
