-- ============================================================================
-- EQ-S2-B2 — widen equipment provenance to admit an official category page
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Exactly one schema change: the same-named source-type CHECK constraint on
-- public.equipment_model_sources is replaced so that it admits a fourth value.
--
--   before: official_product_page, official_spec_pdf, official_archive
--   after:  official_product_page, official_spec_pdf, official_archive,
--           official_category_page
--
-- Nothing else. No column is added, dropped or retyped. No row is read,
-- written, or inferred. Row-level security, table privileges, policies,
-- routines, foreign keys, the HTTPS URL rule, the not-in-the-future
-- verification-date rule and the per-model URL uniqueness rule are all left
-- exactly as they are.
--
-- WHY A FOURTH PROVENANCE CLASS
-- -----------------------------
-- The three existing classes all assume a source that is specific to one
-- model. That assumption holds until a manufacturer retires or redirects an
-- individual product page while continuing to list the exact model, by name,
-- on its own live catalog page. The model is still officially current; the
-- model-specific document simply no longer exists to cite.
--
-- Before this change the only ways to record such a model were to cite a page
-- that does not name it, or to cite something that is not the manufacturer.
-- Both are worse than naming the class honestly. official_category_page exists
-- so that a weaker-but-still-official source is labelled as exactly that,
-- rather than being disguised as a product page.
--
-- FALLBACK ONLY
-- -------------
-- The new value ranks last. It is legitimate only when the page is the
-- manufacturer's own, the exact canonical model is directly named on it as a
-- discrete listed product, and no product page, specification PDF or official
-- archive page can serve as the model-specific source. It never licenses a
-- search result, a retailer or marketplace listing, a review, a press release,
-- a forum, a dealer locator, a social page, or a generic landing page that
-- does not name the model. It is provenance for catalog presence and identity
-- only, and it never supports a technical claim the cited page does not state.
--
-- WHY THE GUARDS PROVE AN EXACT SET, NOT MERE PRESENCE
-- ----------------------------------------------------
-- An earlier draft of this migration asked only whether the three historical
-- labels appeared somewhere in the live rule and whether the new one did not.
-- That is too weak to be allowed to run a replacement. A rule admitting, say,
--
--   official_product_page, official_spec_pdf, official_archive,
--   official_press_release
--
-- satisfies both of those questions, and replacing it would silently erase a
-- newer contract this migration was never written against.
--
-- So both guards below derive the COMPLETE admitted set from the catalog
-- definition and compare it, sorted, against an explicit expected array. They
-- also require the rule to be a simple membership predicate: any additional
-- boolean logic, pattern test, null test, comparison, or reference to a second
-- column is rejected, because extracting the right literals out of an
-- arbitrary expression proves nothing about what that expression admits.
--
-- WHY THE CONSTRAINT IS REPLACED RATHER THAN SUPPLEMENTED
-- ------------------------------------------------------
-- A second CHECK would leave two independent source-type rules on one column,
-- and the narrower of the two would silently win. Replacing the constraint
-- under its original name keeps exactly one authority for this column, so the
-- admitted vocabulary is readable in a single definition.
--
-- WHY NO BACKFILL
-- ---------------
-- Widening a CHECK cannot invalidate stored rows: every value the old rule
-- admitted the new rule still admits. Existing provenance therefore needs no
-- rewrite, and this migration deliberately performs none. Whether any future
-- catalog row uses the new class is a separate, separately authorized data
-- question — this migration adds no catalog row.
--
-- SCOPE BOUNDARY
-- --------------
-- Vocabulary only. No equipment model, no manufacturer, no golfer equipment,
-- no analysis row, and no putter specification is touched. The consumer-side
-- catalog expansion that motivated this prerequisite remains a separate slice.
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail closed unless the live rule is EXACTLY the three historical
-- provenance classes expressed as a simple membership predicate. System
-- catalogs only: pg_class, pg_namespace, pg_constraint and pg_attribute. No
-- application row is read.
-- ============================================================================
do $$
declare
  v_def       text;
  v_norm      text;
  v_blank     text;
  v_found     text[];
  v_literals  int;
  v_col       text;
  v_expected  text[] := array[
    'official_archive',
    'official_product_page',
    'official_spec_pdf'
  ];
begin
  -- A. The provenance table exists as an ordinary table in the expected schema.
  if not exists (
    select 1
      from pg_class rel
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and rel.relkind = 'r'
  ) then
    raise exception 'EQS2B2-PRE-A: public.equipment_model_sources is missing or is not an ordinary table.';
  end if;

  -- B. Exactly one CHECK constraint governs source_type. Two competing rules
  --    would make the admitted vocabulary unreadable.
  if (
    select count(*)
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid, false) ~ '\msource_type\M'
  ) <> 1 then
    raise exception 'EQS2B2-PRE-B: expected exactly one source_type CHECK constraint on public.equipment_model_sources.';
  end if;

  -- C. It carries the expected name. Canonical (non-pretty) rendering is used
  --    so the text compared here is stable rather than display-formatted.
  select pg_get_constraintdef(con.oid, false)
    into v_def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'equipment_model_sources'
     and con.contype = 'c'
     and con.conname = 'equipment_model_sources_type_check';

  if v_def is null then
    raise exception 'EQS2B2-PRE-C: constraint equipment_model_sources_type_check is missing.';
  end if;

  v_norm := btrim(regexp_replace(v_def, '\s+', ' ', 'g'));

  -- D. Shape: a CHECK expressing membership, and nothing more.
  if v_norm !~ '^CHECK ' then
    raise exception 'EQS2B2-PRE-D1: source_type rule is not a CHECK expression. Definition: %', v_norm;
  end if;

  if v_norm !~ '= ANY' and v_norm !~ '\mIN\M' then
    raise exception 'EQS2B2-PRE-D2: source_type rule is not a simple membership predicate. Definition: %', v_norm;
  end if;

  -- Blank every quoted literal, then refuse any additional semantic logic.
  v_blank := upper(regexp_replace(v_norm, '''[^'']*''', ' ', 'g'));

  if v_blank ~ '\mOR\M'
     or v_blank ~ '\mAND\M'
     or v_blank ~ '\mNOT\M'
     or v_blank ~ '\mIS\M'
     or v_blank ~ '\mLIKE\M'
     or v_blank ~ '\mILIKE\M'
     or v_blank ~ '\mSIMILAR\M'
     or v_blank ~ '[<>]'
     or v_blank ~ '!='
     or v_blank ~ '~' then
    raise exception 'EQS2B2-PRE-D3: source_type rule carries extra logic beyond simple membership. Definition: %', v_norm;
  end if;

  -- Exactly one mention of the governed column.
  if (select count(*) from regexp_matches(v_blank, '\mSOURCE_TYPE\M', 'g')) <> 1 then
    raise exception 'EQS2B2-PRE-D4: source_type rule does not reference source_type exactly once. Definition: %', v_norm;
  end if;

  -- No second column may participate in the rule.
  for v_col in
    select att.attname
      from pg_attribute att
      join pg_class rel on rel.oid = att.attrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and att.attnum > 0
       and not att.attisdropped
       and att.attname <> 'source_type'
  loop
    if v_blank ~ ('\m' || upper(v_col) || '\M') then
      raise exception 'EQS2B2-PRE-D5: source_type rule also references column %. Definition: %', v_col, v_norm;
    end if;
  end loop;

  -- E. Exact set equality. Every quoted literal in the rule is collected; the
  --    complete set, sorted and de-duplicated, must equal the expected three.
  --    A duplicate literal is also refused, so the physical rule stays as
  --    readable as the set it denotes.
  select count(*) into v_literals
    from regexp_matches(v_norm, '''([^'']*)''', 'g');

  if v_literals <> array_length(v_expected, 1) then
    raise exception 'EQS2B2-PRE-E1: source_type rule names % literals, expected %. Definition: %',
      v_literals, array_length(v_expected, 1), v_norm;
  end if;

  select coalesce(array_agg(distinct m[1] order by m[1]), array[]::text[])
    into v_found
    from regexp_matches(v_norm, '''([^'']*)''', 'g') as m;

  if v_found is distinct from (select array_agg(x order by x) from unnest(v_expected) as x) then
    raise exception 'EQS2B2-PRE-E2: source_type rule admits % but exactly % was expected. Definition: %',
      v_found, v_expected, v_norm;
  end if;

  -- F. official_category_page is absent as a consequence of E, not by a
  --    standalone substring test. This is a redundant belt-and-braces guard.
  if 'official_category_page' = any (v_found) then
    raise exception 'EQS2B2-PRE-F: source_type rule already admits official_category_page.';
  end if;

  -- G. The sibling rules this migration must leave alone are all present.
  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_url_https'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_verified_not_future'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_model_url_unique'
  ) then
    raise exception 'EQS2B2-PRE-G: the expected sibling constraints on public.equipment_model_sources are not all present.';
  end if;
end $$;

-- ============================================================================
-- THE CHANGE — replace the source-type rule under its original name.
--
-- Widening is safe against stored data by construction: the new admitted set
-- is a strict superset of the old one, so no existing row can be invalidated
-- and no row rewrite is required or performed.
-- ============================================================================

alter table public.equipment_model_sources
  drop constraint equipment_model_sources_type_check;

alter table public.equipment_model_sources
  add constraint equipment_model_sources_type_check check (
    source_type in (
      'official_product_page',
      'official_spec_pdf',
      'official_archive',
      'official_category_page'
    )
  );

-- ============================================================================
-- POST — prove the resulting state with the same exact-set discipline, from
-- system catalogs only. Any failure here rolls back the replacement above,
-- because the whole migration is one transaction.
-- ============================================================================
do $$
declare
  v_def       text;
  v_norm      text;
  v_blank     text;
  v_found     text[];
  v_literals  int;
  v_col       text;
  v_expected  text[] := array[
    'official_archive',
    'official_category_page',
    'official_product_page',
    'official_spec_pdf'
  ];
begin
  -- 1. The named rule exists.
  select pg_get_constraintdef(con.oid, false)
    into v_def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'equipment_model_sources'
     and con.contype = 'c'
     and con.conname = 'equipment_model_sources_type_check';

  if v_def is null then
    raise exception 'EQS2B2-POST-1: equipment_model_sources_type_check is missing after the replacement.';
  end if;

  -- 2. Still exactly one rule governs source_type.
  if (
    select count(*)
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid, false) ~ '\msource_type\M'
  ) <> 1 then
    raise exception 'EQS2B2-POST-2: public.equipment_model_sources no longer has exactly one source_type CHECK constraint.';
  end if;

  v_norm := btrim(regexp_replace(v_def, '\s+', ' ', 'g'));

  -- 3. Shape: still a simple membership predicate and nothing more.
  if v_norm !~ '^CHECK ' then
    raise exception 'EQS2B2-POST-3A: resulting source_type rule is not a CHECK expression. Definition: %', v_norm;
  end if;

  if v_norm !~ '= ANY' and v_norm !~ '\mIN\M' then
    raise exception 'EQS2B2-POST-3B: resulting source_type rule is not a simple membership predicate. Definition: %', v_norm;
  end if;

  v_blank := upper(regexp_replace(v_norm, '''[^'']*''', ' ', 'g'));

  if v_blank ~ '\mOR\M'
     or v_blank ~ '\mAND\M'
     or v_blank ~ '\mNOT\M'
     or v_blank ~ '\mIS\M'
     or v_blank ~ '\mLIKE\M'
     or v_blank ~ '\mILIKE\M'
     or v_blank ~ '\mSIMILAR\M'
     or v_blank ~ '[<>]'
     or v_blank ~ '!='
     or v_blank ~ '~' then
    raise exception 'EQS2B2-POST-3C: resulting source_type rule carries extra logic beyond simple membership. Definition: %', v_norm;
  end if;

  if (select count(*) from regexp_matches(v_blank, '\mSOURCE_TYPE\M', 'g')) <> 1 then
    raise exception 'EQS2B2-POST-3D: resulting source_type rule does not reference source_type exactly once. Definition: %', v_norm;
  end if;

  for v_col in
    select att.attname
      from pg_attribute att
      join pg_class rel on rel.oid = att.attrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and att.attnum > 0
       and not att.attisdropped
       and att.attname <> 'source_type'
  loop
    if v_blank ~ ('\m' || upper(v_col) || '\M') then
      raise exception 'EQS2B2-POST-3E: resulting source_type rule also references column %. Definition: %', v_col, v_norm;
    end if;
  end loop;

  -- 4. Exact set equality against the four authorized classes.
  select count(*) into v_literals
    from regexp_matches(v_norm, '''([^'']*)''', 'g');

  if v_literals <> array_length(v_expected, 1) then
    raise exception 'EQS2B2-POST-4A: resulting source_type rule names % literals, expected %. Definition: %',
      v_literals, array_length(v_expected, 1), v_norm;
  end if;

  select coalesce(array_agg(distinct m[1] order by m[1]), array[]::text[])
    into v_found
    from regexp_matches(v_norm, '''([^'']*)''', 'g') as m;

  if v_found is distinct from (select array_agg(x order by x) from unnest(v_expected) as x) then
    raise exception 'EQS2B2-POST-4B: resulting source_type rule admits % but exactly % was expected. Definition: %',
      v_found, v_expected, v_norm;
  end if;

  -- 5. The sibling rules are untouched.
  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_url_https'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_verified_not_future'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_model_url_unique'
  ) then
    raise exception 'EQS2B2-POST-5: a sibling constraint on public.equipment_model_sources went missing.';
  end if;

  -- 6. Row-level security remains enabled on the provenance table.
  if not exists (
    select 1
      from pg_class rel
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and rel.relrowsecurity
  ) then
    raise exception 'EQS2B2-POST-6: row-level security is no longer enabled on public.equipment_model_sources.';
  end if;
end $$;

commit;
