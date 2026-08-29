import { notFound, redirect } from "next/navigation";
import { createClient, getServerSession } from "@/utils/supabase/server";
import EditClubForm, { type EditableClub } from "./EditClubForm";

export const metadata = { title: "Edit Club — SwingProAI" };

/**
 * Edit the owner-controlled fitting attributes of one saved club.
 *
 * WHAT IS AND IS NOT EDITABLE
 * ---------------------------
 * Only club_designation, loft_deg, shaft_flex, shaft_weight and is_primary. A
 * saved row's equipment identity — club_type, the canonical catalog references,
 * and the custom brand/model text — is immutable here. Correcting how a club is
 * fitted is a different act from turning one saved club into a different club;
 * the latter is delete-and-add, not an edit.
 *
 * That immutability is also why no canonical catalog is loaded on this route.
 * There is nothing for a manufacturer/model selector to change, so the browser
 * receives no catalog data at all.
 *
 * OWNERSHIP
 * ---------
 * The clubId arrives from the URL and is therefore untrusted. Authorization
 * comes from the query itself — the row is fetched scoped by both id and the
 * authenticated user_id — and from the RLS policy behind it. A row belonging to
 * someone else and a row that does not exist both resolve to notFound(), so the
 * route cannot be used to probe whether another golfer's club id is real.
 *
 * An archived club joins them. The lookup is scoped by is_archived=false, so a
 * club the golfer has removed from their bag is not editable through a kept URL
 * and produces the same notFound() as the other two cases — the route discloses
 * no distinction between "never existed", "not yours" and "archived".
 */
export default async function EditClubPage({ params }: { params: { clubId: string } }) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const supabase = await createClient();

  // Exactly the columns this form reads or writes. club_type is fetched because
  // it decides which designations are legal, not because it can be edited.
  const { data: club } = await supabase
    .from("user_equipment")
    .select("id, club_type, club_designation, loft_deg, shaft_flex, shaft_weight, is_primary")
    .eq("id", params.clubId)
    .eq("user_id", session.user.id)
    .eq("is_archived", false)
    .maybeSingle();

  if (!club) notFound();

  return (
    <div className="p-6 lg:p-8">
      <div className="max-w-lg mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">Edit Club</h1>
          <p className="text-sm text-gray-400 mt-1">
            Update the fitting details for this club. Its make and model cannot be changed here.
          </p>
        </div>
        <EditClubForm club={club as EditableClub} userId={session.user.id} />
      </div>
    </div>
  );
}
