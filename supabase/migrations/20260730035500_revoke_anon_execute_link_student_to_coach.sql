begin;

revoke execute on function public.link_student_to_coach(text) from public;

revoke execute on function public.link_student_to_coach(text) from anon;

commit;
