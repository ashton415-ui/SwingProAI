"use client";

/**
 * SwingProAI — Equipment Consumer Slice 2: shared club selector
 *
 * A controlled, presentational picker over a golfer's already-loaded saved
 * clubs. It is the UI primitive the later desktop Analyze selector and mobile
 * recording selector are both meant to use, so it deliberately owns nothing but
 * presentation: no data access, no submission, no entitlement checks, no
 * routing decisions.
 *
 * It has no live consumer in this slice. That is intentional — the first
 * consumer arrives with the Analyze wiring, and shipping the contract first
 * keeps that slice from having to invent and adopt an abstraction at once.
 *
 * A native <select> is used rather than a custom listbox because it is keyboard
 * and screen-reader native for free, and on phones it opens the operating
 * system's own picker — which is both the most usable control at that width and
 * the one that needs no bespoke touch handling.
 */

import { useId } from "react";
import type { SelectableClub } from "@/lib/equipment/saved-clubs";

/** The sentinel `<option>` value standing for "nothing chosen". */
const NO_SELECTION_VALUE = "";

export interface ClubSelectorProps {
  clubs: readonly SelectableClub[];
  selectedClubId: string | null;
  onChange: (clubId: string | null) => void;
  disabled?: boolean;
  allowEmpty?: boolean;
  label?: string;
  id?: string;
  emptyMessage?: string;
}

/**
 * Group by club type while preserving the order the clubs arrived in.
 *
 * A Map keeps first-seen insertion order, so the caller's deterministic
 * ordering survives grouping, and a club type that somehow appeared
 * non-contiguously still lands in a single group rather than a duplicate one.
 */
function groupByClubType(
  clubs: readonly SelectableClub[]
): Array<[SelectableClub["clubType"], SelectableClub[]]> {
  const groups = new Map<SelectableClub["clubType"], SelectableClub[]>();

  for (const club of clubs) {
    const existing = groups.get(club.clubType);
    if (existing) {
      existing.push(club);
    } else {
      groups.set(club.clubType, [club]);
    }
  }

  return Array.from(groups);
}

export default function ClubSelector({
  clubs,
  selectedClubId,
  onChange,
  disabled = false,
  allowEmpty = true,
  label = "Club",
  id,
  emptyMessage = "No saved clubs yet. Add a club to your bag first.",
}: ClubSelectorProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const helpId = `${selectId}-help`;

  const hasClubs = clubs.length > 0;
  // An empty bag leaves nothing to choose, so the control is inert rather than
  // presenting an option that cannot be acted on.
  const isDisabled = disabled || !hasClubs;
  const groups = groupByClubType(clubs);

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    // The sentinel maps back to null so callers never have to know it exists.
    onChange(value === NO_SELECTION_VALUE ? null : value);
  }

  // Full width with a comfortable minimum height, matching the project's touch
  // target posture. No fixed width floor is set, so the control can always
  // shrink to the viewport instead of forcing horizontal scrolling.
  const selectClassName =
    "w-full min-h-11 bg-slate-800 border border-white/10 rounded-xl px-4 py-2.5 text-white text-base lg:text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="w-full">
      <label htmlFor={selectId} className="block text-sm font-medium text-gray-300 mb-2">
        {label}
      </label>

      <select
        id={selectId}
        value={selectedClubId ?? NO_SELECTION_VALUE}
        onChange={handleChange}
        disabled={isDisabled}
        required={!allowEmpty}
        aria-describedby={hasClubs ? undefined : helpId}
        className={selectClassName}
      >
        {!hasClubs && <option value={NO_SELECTION_VALUE}>No saved clubs</option>}

        {/* With clubs present, the leading option is either a real choice or a
            disabled prompt — never a silent default. Nothing is auto-selected:
            not the primary club, not the first club, not the first group. */}
        {hasClubs && allowEmpty && <option value={NO_SELECTION_VALUE}>No club selected</option>}
        {hasClubs && !allowEmpty && (
          <option value={NO_SELECTION_VALUE} disabled>
            Select a club
          </option>
        )}

        {groups.map(([clubType, group]) => (
          <optgroup key={clubType} label={clubType}>
            {group.map((club) => (
              <option key={club.id} value={club.id}>
                {club.isPrimary ? `${club.displayName} — Primary` : club.displayName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {!hasClubs && (
        <p id={helpId} className="text-sm text-gray-400 mt-2">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
