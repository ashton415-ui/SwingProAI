export interface Drill {
  name: string;
  description: string;
  duration: string;
  category: "driving" | "irons" | "short_game" | "putting" | "mental";
}

export interface Week {
  week: number;
  theme: string;
  focus: string;
  drills: Drill[];
  weekly_goal: string;
  pro_tip: string;
}

export interface SyllabusData {
  summary: string;
  weeks: Week[];
}
