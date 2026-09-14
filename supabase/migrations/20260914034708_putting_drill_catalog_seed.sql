-- ============================================================================
-- putting_drill_catalog_seed — the first canonical putting drills.
--
-- EQ5D. Unit S made public.drills.drill_family authoritative; Unit F made the
-- two active full-swing consumers filter on it positively. Only once both were
-- true could a putting drill exist in the canonical catalog without leaking
-- into the full-swing drill library or the full-swing verification pipeline.
-- This migration inserts the seven-row putting catalog those slices unblocked.
--
-- Data only, and insert only. It adds no column, no constraint, no policy and
-- no grant, and it rewrites no existing row: the five full-swing drills already
-- in production are untouched. created_at is deliberately absent from the
-- column list so the database supplies it.
--
-- Every row states drill_family = 'putting' explicitly. The column has no
-- default, so nothing here can be classified by omission.
--
-- ai_verification_prompt is NOT NULL but putting verification does not exist.
-- Each row therefore carries one uniform sentinel rather than a coaching
-- prompt: it satisfies the constraint, is exactly searchable when putting
-- verification is eventually built, and carries no instruction a model could
-- act on if the Unit F firewall were ever breached.
--
-- The ids are deterministic RFC 4122 v5 UUIDs over
-- swingproai:drill:putting:<slug> in the standard URL namespace, so staging and
-- production hold the same drill under the same primary key. They are written
-- as literals; no UUID is generated at execution time.
--
-- Not idempotent by design. If a canonical id or name already exists the
-- preflight raises and the transaction rolls back, because silent conflict
-- suppression would hide a partial or drifted seed.
--
-- The preflight asserts nothing about total row count: staging holds 0 drills
-- and production holds 5, and the same migration must be valid for both.
-- ============================================================================

begin;

-- Taken before anything is read, so the existence checks below cannot be
-- invalidated by a concurrent write between preflight and insert.
lock table public.drills in access exclusive mode;

-- ============================================================================
-- PREFLIGHT
-- ============================================================================
do $$
declare
  v_ids uuid[] := array[
    'd0366fc8-c428-5a21-a145-18ef24b15220'::uuid,
    '87a51ed8-6cdc-50c7-864b-2bb9d88af5f7'::uuid,
    '25299bc9-cee3-5188-b01e-b678f3b5d5f2'::uuid,
    'bcae0cfe-9834-5502-9e0b-03b93d5c8a10'::uuid,
    '0975bf69-b793-515a-bf5e-7f5a582d2c74'::uuid,
    '6530ed44-b218-519d-9cdd-57cf2199e44e'::uuid,
    'e9e69977-64e7-582f-b721-228f594e7f9a'::uuid
  ];
  v_names text[] := array[
    'Eye-Line Setup Check',
    'Start-Line Gate',
    'Heel-Toe Strike Gate',
    'Rail Path Channel',
    'Distance Ladder',
    'Two-Count Tempo',
    'Three-Foot Circle'
  ];
  v_missing text;
  v_count integer;
begin
  -- PRE-01: the canonical catalog exists as an ordinary table.
  if not exists (
    select 1
      from pg_class rel
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'drills'
       and rel.relkind = 'r'
  ) then
    raise exception
      'PUTTING-SEED-PRE-01: public.drills does not exist as an ordinary table.';
  end if;

  -- PRE-02: every column this migration writes explicitly exists.
  select string_agg(needed, ', ' order by needed)
    into v_missing
    from unnest(array[
           'id', 'name', 'target_metric', 'the_why', 'the_how', 'the_feel',
           'ai_verification_prompt', 'instructional_video_url', 'drill_family'
         ]) as needed
   where not exists (
     select 1
       from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'drills'
        and column_name  = needed
   );
  if v_missing is not null then
    raise exception
      'PUTTING-SEED-PRE-02: public.drills is missing required column(s): %.',
      v_missing;
  end if;

  -- PRE-03: family is required, so no row can be seeded without one.
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'drills'
       and column_name  = 'drill_family'
       and is_nullable <> 'NO'
  ) then
    raise exception
      'PUTTING-SEED-PRE-03: public.drills.drill_family is not NOT NULL.';
  end if;

  -- PRE-04: no canonical id is already present.
  select count(*) into v_count from public.drills where id = any (v_ids);
  if v_count <> 0 then
    raise exception
      'PUTTING-SEED-PRE-04: % canonical putting id(s) already exist.', v_count;
  end if;

  -- PRE-05: no canonical name is already present. public.drills has no unique
  -- constraint on name, so this is checked rather than assumed.
  select count(*) into v_count from public.drills where name = any (v_names);
  if v_count <> 0 then
    raise exception
      'PUTTING-SEED-PRE-05: % canonical putting name(s) already exist.', v_count;
  end if;

  -- PRE-06: no existing row collides on either half of an id/name pairing.
  select count(*)
    into v_count
    from public.drills
   where id = any (v_ids)
      or name = any (v_names);
  if v_count <> 0 then
    raise exception
      'PUTTING-SEED-PRE-06: % existing row(s) conflict with a proposed id or name.',
      v_count;
  end if;

  -- PRE-07: the proposed identities are exactly seven, mutually unique.
  if array_length(v_ids, 1) <> 7
     or (select count(distinct u) from unnest(v_ids) as u) <> 7 then
    raise exception
      'PUTTING-SEED-PRE-07: the proposed ids are not seven mutually unique values.';
  end if;
  if array_length(v_names, 1) <> 7
     or (select count(distinct u) from unnest(v_names) as u) <> 7 then
    raise exception
      'PUTTING-SEED-PRE-07: the proposed names are not seven mutually unique values.';
  end if;
end
$$;

-- ============================================================================
-- SEED — the only write in this migration.
-- ============================================================================
insert into public.drills (
  id,
  name,
  target_metric,
  the_why,
  the_how,
  the_feel,
  ai_verification_prompt,
  instructional_video_url,
  drill_family
)
values
  (
    'd0366fc8-c428-5a21-a145-18ef24b15220',
    'Eye-Line Setup Check',
    'address_setup',
    'Where the eyes sit relative to the ball-target line changes how the start line looks from address, so a setup that varies between putts can make the same stroke aim differently.',
    'On a flat 6-foot putt take your normal address, then drop a second ball from the bridge of your nose and mark where it lands. Repeat five times. Success: the five marks fall within one ball-width of each other and each sits on or just inside the ball-target line.',
    'A still, balanced head, and a start line that looks the same at address on every rep.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  ),
  (
    '87a51ed8-6cdc-50c7-864b-2bb9d88af5f7',
    'Start-Line Gate',
    'start_line_control',
    'If the ball does not start on the line you chose, a good read cannot help and a poor read cannot be diagnosed. Gating the start line separates face control from green reading.',
    'On a flat 6-foot putt set two tees as a gate about one and a half ball-widths wide, 12 inches ahead of the ball on your intended start line. Hit 10 putts. Success: 8 of 10 pass through without touching a tee.',
    'The face square to the start line through impact, on a line committed to before the stroke begins.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  ),
  (
    '25299bc9-cee3-5188-b01e-b678f3b5d5f2',
    'Heel-Toe Strike Gate',
    'strike_location',
    'A putt struck away from the center of the face tends to lose ball speed and turn the face slightly, so strokes that feel identical can finish different distances. Consistent strike makes other putting feedback trustworthy.',
    'Place a tee just outside the heel and just outside the toe of the putter head at address, forming a gate the head must pass through. Hit 10 putts of 10 feet. Success: 9 of 10 with no tee contact and the same sound off the face.',
    'The ball leaving the middle of the face with one repeatable, solid sound.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  ),
  (
    'bcae0cfe-9834-5502-9e0b-03b93d5c8a10',
    'Rail Path Channel',
    'stroke_path_control',
    'A stroke that moves sharply across the intended line forces the face to compensate, so two variables must be timed instead of one repeated. A channel shows excessive lateral movement while still allowing the gentle arc most strokes have.',
    'Lay two alignment sticks as a channel a little wider than the putter head, aimed at the hole on a flat 8-foot putt, wide enough that your normal arc passes through untouched. Make 10 strokes. Success: 9 of 10 with no stick contact and the ball finishing in the hole or within one ball past.',
    'The head tracking its own shallow arc inside the channel, shoulders rocking rather than hands steering it straight.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  ),
  (
    '0975bf69-b793-515a-bf5e-7f5a582d2c74',
    'Distance Ladder',
    'distance_control',
    'Poor distance control is a common contributor to three-putting, particularly from longer range. Speed is a calibration skill, so it improves faster with feedback at several lengths than with repetition at one.',
    'Place tees at 15, 25, 35 and 45 feet on a flat section. Putt one ball to each in ascending order, then descending. Success: every ball finishes past its tee but within three feet of it. A ball short, or more than three feet past, restarts the ladder.',
    'Stroke length changing with distance while the rhythm stays the same, so the stroke gets longer rather than quicker.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  ),
  (
    '6530ed44-b218-519d-9cdd-57cf2199e44e',
    'Two-Count Tempo',
    'stroke_tempo',
    'An inconsistent rhythm, such as a rushed transition or a long backstroke rescued by a short quick strike, makes face, strike and distance harder to repeat. Holding one cadence lets stroke length do most of the work.',
    'Use a simple two-beat count: one on the backstroke, two through impact. Hit 10 putts of 20 feet holding that count and letting only stroke length change. Success: 8 of 10 keep the count unchanged with a through-stroke at least as long as the backstroke. A metronome is an optional aid, set to whatever beat suits your own stroke.',
    'One unhurried beat repeating, the same whether the putt is short or long.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  ),
  (
    'e9e69977-64e7-582f-b721-228f594e7f9a',
    'Three-Foot Circle',
    'short_putt_conversion',
    'Putts inside a few feet are expected to be holed, so a miss costs a shot already counted on. Holing them in an unbroken run adds a consequence that repeating the same putt does not.',
    'Place six balls in a circle three feet from the hole, evenly spaced so each putt has a different break. Hole all six in a row; a miss restarts the circle. Complete two full circles.',
    'The same unhurried routine on the sixth putt as on the first.',
    'unsupported:putting_verification_not_implemented',
    NULL,
    'putting'
  );

-- ============================================================================
-- POSTFLIGHT
-- ============================================================================
do $$
declare
  v_ids uuid[] := array[
    'd0366fc8-c428-5a21-a145-18ef24b15220'::uuid,
    '87a51ed8-6cdc-50c7-864b-2bb9d88af5f7'::uuid,
    '25299bc9-cee3-5188-b01e-b678f3b5d5f2'::uuid,
    'bcae0cfe-9834-5502-9e0b-03b93d5c8a10'::uuid,
    '0975bf69-b793-515a-bf5e-7f5a582d2c74'::uuid,
    '6530ed44-b218-519d-9cdd-57cf2199e44e'::uuid,
    'e9e69977-64e7-582f-b721-228f594e7f9a'::uuid
  ];
  v_count integer;
  v_bad integer;
begin
  -- POST-01: exactly the seven canonical rows are present.
  select count(*) into v_count from public.drills where id = any (v_ids);
  if v_count <> 7 then
    raise exception
      'PUTTING-SEED-POST-01: expected 7 canonical putting rows, found %.', v_count;
  end if;

  -- POST-02: all seven are putting, none NULL.
  select count(*)
    into v_count
    from public.drills
   where id = any (v_ids)
     and drill_family = 'putting';
  if v_count <> 7 then
    raise exception
      'PUTTING-SEED-POST-02: only % of 7 canonical rows carry drill_family putting.',
      v_count;
  end if;
  select count(*)
    into v_count
    from public.drills
   where id = any (v_ids)
     and drill_family is null;
  if v_count <> 0 then
    raise exception
      'PUTTING-SEED-POST-02: % canonical row(s) have a NULL drill_family.', v_count;
  end if;

  -- POST-08: every seeded row carries the exact unsupported-verification
  -- sentinel, so a future putting verification slice can find them all.
  select count(*)
    into v_count
    from public.drills
   where id = any (v_ids)
     and ai_verification_prompt = 'unsupported:putting_verification_not_implemented';
  if v_count <> 7 then
    raise exception
      'PUTTING-SEED-POST-08: only % of 7 canonical rows carry the exact sentinel.',
      v_count;
  end if;

  -- POST-09: no instructional video is claimed for any seeded row.
  select count(*)
    into v_count
    from public.drills
   where id = any (v_ids)
     and instructional_video_url is null;
  if v_count <> 7 then
    raise exception
      'PUTTING-SEED-POST-09: only % of 7 canonical rows have a NULL instructional_video_url.',
      v_count;
  end if;

  -- POST-03..07 and POST-10: every frozen field of every seeded row matches the
  -- adjudicated manifest exactly. A single relation so no field is checked by
  -- eye, and `is distinct from` so a NULL cannot pass as a match.
  with expected (
    id, name, target_metric, the_why, the_how, the_feel,
    ai_verification_prompt, drill_family
  ) as (
    values
      (
        'd0366fc8-c428-5a21-a145-18ef24b15220'::uuid,
        'Eye-Line Setup Check'::text,
        'address_setup'::text,
        'Where the eyes sit relative to the ball-target line changes how the start line looks from address, so a setup that varies between putts can make the same stroke aim differently.'::text,
        'On a flat 6-foot putt take your normal address, then drop a second ball from the bridge of your nose and mark where it lands. Repeat five times. Success: the five marks fall within one ball-width of each other and each sits on or just inside the ball-target line.'::text,
        'A still, balanced head, and a start line that looks the same at address on every rep.'::text,
        'unsupported:putting_verification_not_implemented'::text,
        'putting'::text
      ),
      (
        '87a51ed8-6cdc-50c7-864b-2bb9d88af5f7'::uuid,
        'Start-Line Gate',
        'start_line_control',
        'If the ball does not start on the line you chose, a good read cannot help and a poor read cannot be diagnosed. Gating the start line separates face control from green reading.',
        'On a flat 6-foot putt set two tees as a gate about one and a half ball-widths wide, 12 inches ahead of the ball on your intended start line. Hit 10 putts. Success: 8 of 10 pass through without touching a tee.',
        'The face square to the start line through impact, on a line committed to before the stroke begins.',
        'unsupported:putting_verification_not_implemented',
        'putting'
      ),
      (
        '25299bc9-cee3-5188-b01e-b678f3b5d5f2'::uuid,
        'Heel-Toe Strike Gate',
        'strike_location',
        'A putt struck away from the center of the face tends to lose ball speed and turn the face slightly, so strokes that feel identical can finish different distances. Consistent strike makes other putting feedback trustworthy.',
        'Place a tee just outside the heel and just outside the toe of the putter head at address, forming a gate the head must pass through. Hit 10 putts of 10 feet. Success: 9 of 10 with no tee contact and the same sound off the face.',
        'The ball leaving the middle of the face with one repeatable, solid sound.',
        'unsupported:putting_verification_not_implemented',
        'putting'
      ),
      (
        'bcae0cfe-9834-5502-9e0b-03b93d5c8a10'::uuid,
        'Rail Path Channel',
        'stroke_path_control',
        'A stroke that moves sharply across the intended line forces the face to compensate, so two variables must be timed instead of one repeated. A channel shows excessive lateral movement while still allowing the gentle arc most strokes have.',
        'Lay two alignment sticks as a channel a little wider than the putter head, aimed at the hole on a flat 8-foot putt, wide enough that your normal arc passes through untouched. Make 10 strokes. Success: 9 of 10 with no stick contact and the ball finishing in the hole or within one ball past.',
        'The head tracking its own shallow arc inside the channel, shoulders rocking rather than hands steering it straight.',
        'unsupported:putting_verification_not_implemented',
        'putting'
      ),
      (
        '0975bf69-b793-515a-bf5e-7f5a582d2c74'::uuid,
        'Distance Ladder',
        'distance_control',
        'Poor distance control is a common contributor to three-putting, particularly from longer range. Speed is a calibration skill, so it improves faster with feedback at several lengths than with repetition at one.',
        'Place tees at 15, 25, 35 and 45 feet on a flat section. Putt one ball to each in ascending order, then descending. Success: every ball finishes past its tee but within three feet of it. A ball short, or more than three feet past, restarts the ladder.',
        'Stroke length changing with distance while the rhythm stays the same, so the stroke gets longer rather than quicker.',
        'unsupported:putting_verification_not_implemented',
        'putting'
      ),
      (
        '6530ed44-b218-519d-9cdd-57cf2199e44e'::uuid,
        'Two-Count Tempo',
        'stroke_tempo',
        'An inconsistent rhythm, such as a rushed transition or a long backstroke rescued by a short quick strike, makes face, strike and distance harder to repeat. Holding one cadence lets stroke length do most of the work.',
        'Use a simple two-beat count: one on the backstroke, two through impact. Hit 10 putts of 20 feet holding that count and letting only stroke length change. Success: 8 of 10 keep the count unchanged with a through-stroke at least as long as the backstroke. A metronome is an optional aid, set to whatever beat suits your own stroke.',
        'One unhurried beat repeating, the same whether the putt is short or long.',
        'unsupported:putting_verification_not_implemented',
        'putting'
      ),
      (
        'e9e69977-64e7-582f-b721-228f594e7f9a'::uuid,
        'Three-Foot Circle',
        'short_putt_conversion',
        'Putts inside a few feet are expected to be holed, so a miss costs a shot already counted on. Holing them in an unbroken run adds a consequence that repeating the same putt does not.',
        'Place six balls in a circle three feet from the hole, evenly spaced so each putt has a different break. Hole all six in a row; a miss restarts the circle. Complete two full circles.',
        'The same unhurried routine on the sixth putt as on the first.',
        'unsupported:putting_verification_not_implemented',
        'putting'
      )
  )
  select count(*)
    into v_bad
    from expected e
    left join public.drills d on d.id = e.id
   where d.id is null
      or d.name is distinct from e.name
      or d.target_metric is distinct from e.target_metric
      or d.the_why is distinct from e.the_why
      or d.the_how is distinct from e.the_how
      or d.the_feel is distinct from e.the_feel
      or d.ai_verification_prompt is distinct from e.ai_verification_prompt
      or d.drill_family is distinct from e.drill_family
      or d.instructional_video_url is not null;
  if v_bad <> 0 then
    raise exception
      'PUTTING-SEED-POST-10: % seeded row(s) do not match the frozen manifest exactly.',
      v_bad;
  end if;
end
$$;

commit;
