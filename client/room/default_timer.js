import { GameMode } from 'pixel_combats/room';

const PARAMETER_GAME_LENGTH = 'default_game_mode_length';

export function game_mode_length_seconds() {
    const length = GameMode.Parameters.GetString(PARAMETER_GAME_LENGTH);
    switch (length) {
        case 'Length_S': return 300;  // 5 min
        case 'Length_M': return 420;  // 7 min
        case 'Length_L': return 600;  // 10 min
    }
    return 420;
}
