import { Color } from 'pixel_combats/basic';
import { Teams } from 'pixel_combats/room';

export const CREW_TEAM_NAME = "Crew";
export const IMPOSTER_TEAM_NAME = "Imposter";
export const GHOST_TEAM_NAME = "Ghost";
export const CREW_TEAM_DISPLAY_NAME = "Teams/Crew";
export const IMPOSTER_TEAM_DISPLAY_NAME = "Teams/Imposter";
export const GHOST_TEAM_DISPLAY_NAME = "Teams/Ghost";

export const CREW_TEAM_COLOR = new Color(0, 0, 1, 0); // Синий
export const IMPOSTER_TEAM_COLOR = new Color(1, 0, 0, 0); // Красный
export const GHOST_TEAM_COLOR = new Color(0.5, 0.5, 0.5, 0.5); // Серый полупрозрачный

export function create_teams() {
    // Команда мирных
    Teams.Add(CREW_TEAM_NAME, CREW_TEAM_DISPLAY_NAME, CREW_TEAM_COLOR);
    const crewTeam = Teams.Get(CREW_TEAM_NAME);
    
    // Команда предателей
    Teams.Add(IMPOSTER_TEAM_NAME, IMPOSTER_TEAM_DISPLAY_NAME, IMPOSTER_TEAM_COLOR);
    const imposterTeam = Teams.Get(IMPOSTER_TEAM_NAME);
    
    // Команда призраков (мертвых игроков)
    Teams.Add(GHOST_TEAM_NAME, GHOST_TEAM_DISPLAY_NAME, GHOST_TEAM_COLOR);
    const ghostTeam = Teams.Get(GHOST_TEAM_NAME);
    
    return { crewTeam, imposterTeam, ghostTeam };
}
