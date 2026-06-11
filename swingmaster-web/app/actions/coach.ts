'use server';

import { createClient } from '@/utils/supabase/server';

export type LinkResult = { success: boolean; error?: string };

export async function linkStudentToCoach(inviteCode: string): Promise<LinkResult> {
  const code = inviteCode.toUpperCase().trim();
  if (code.length !== 6) {
    return { success: false, error: 'Code must be exactly 6 characters.' };
  }

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not authenticated.' };

  const { data, error } = await supabase.rpc('link_student_to_coach', {
    invite_code: code,
  });

  if (error) {
    console.error('[linkStudentToCoach]', error.message);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }

  return data as LinkResult;
}
