import { DisplayValueHeader } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, Teams, Damage, Ui, Properties, GameMode, Spawns, Timers, Chat } from 'pixel_combats/room';
import * as teams from './default_teams.js';
import * as default_timer from './default_timer.js';

// Настройки
const LOBBY_TIME = 30;
const KILL_COOLDOWN = 30;
const DISCUSSION_TIME = 15;
const VOTING_TIME = 30;
const GAME_TIME = default_timer.game_mode_length_seconds();

// Состояния игры
const LOBBY_STATE = "Lobby";
const PLAY_STATE = "Play";
const DISCUSSION_STATE = "Discussion";
const VOTING_STATE = "Voting";
const GAME_OVER_STATE = "GameOver";

// Константы
const IMMORTALITY_TIMER_NAME = "immortality";
const KILLS_PROP_NAME = "Kills";
const ROLE_PROP_NAME = "Role";
const IS_ALIVE_PROP_NAME = "IsAlive";
const CAN_REPORT_PROP_NAME = "CanReport";
const CAN_KILL_PROP_NAME = "CanKill";
const KILL_COOLDOWN_TIMER = "KillCD";

// Роли
const ROLES = {
    CREWMATE: "Crewmate",
    IMPOSTER: "Imposter",
    SHERIFF: "Sheriff",
    MEDIC: "Medic"
};

// Получаем объекты
const mainTimer = Timers.GetContext().Get("Main");
const stateProp = Properties.GetContext().Get("State");
const killCooldownTimer = Timers.GetContext().Get(KILL_COOLDOWN_TIMER);

// Применяем параметры режима
const minPlayersStr = GameMode.Parameters.GetString("MinPlayers");
const impostersCountStr = GameMode.Parameters.GetString("ImpostersCount");
const ENABLE_SHERIFF = GameMode.Parameters.GetBool("EnableSheriff");
const ENABLE_MEDIC = GameMode.Parameters.GetBool("EnableMedic");
const FREEZE_ON_DEATH = GameMode.Parameters.GetBool("FreezeOnDeath");

const MIN_PLAYERS = {
    "Min_1": 1, "Min_2": 2, "Min_4": 4, "Min_6": 6, "Min_8": 8
}[minPlayersStr] || 1;

const IMPOSTERS_COUNT = {
    "Imp_1": 1, "Imp_2": 2, "Imp_3": 3
}[impostersCountStr] || 1;

// Создаем команды
const { crewTeam, imposterTeam, ghostTeam } = teams.create_teams();

// Настройка лидерборда
LeaderBoard.PlayerLeaderBoardValues = [
    new DisplayValueHeader(KILLS_PROP_NAME, "Statistics/Kills", "Statistics/KillsShort"),
    new DisplayValueHeader(ROLE_PROP_NAME, "Statistics/Role", "Statistics/RoleShort")
];

// Переменные режима
let gameData = {
    deadPlayers: new Set(),
    reportedBodies: new Set(),
    killCooldowns: new Map(),
    meetingsCount: 0,
    emergencyAvailable: true
};

// Инициализация игрока
function initPlayer(player) {
    player.Properties.Get(KILLS_PROP_NAME).Value = 0;
    player.Properties.Get(ROLE_PROP_NAME).Value = ROLES.CREWMATE;
    player.Properties.Get(IS_ALIVE_PROP_NAME).Value = true;
    player.Properties.Get(CAN_REPORT_PROP_NAME).Value = true;
    player.Properties.Get(CAN_KILL_PROP_NAME).Value = false;
    
    crewTeam.Add(player);
    player.Timers.Get(KILL_COOLDOWN_TIMER).Stop();
}

// Распределение ролей
function assignRoles() {
    const players = Array.from(Players.All);
    if (players.length < MIN_PLAYERS) return false;
    
    // Выбираем предателей
    for (let i = 0; i < IMPOSTERS_COUNT && i < players.length; i++) {
        const randomIndex = Math.floor(Math.random() * players.length);
        const imposter = players.splice(randomIndex, 1)[0];
        imposter.Properties.Get(ROLE_PROP_NAME).Value = ROLES.IMPOSTER;
        imposter.Properties.Get(CAN_KILL_PROP_NAME).Value = true;
        imposterTeam.Add(imposter);
    }
    
    // Выбираем шерифа (если включен)
    if (ENABLE_SHERIFF && players.length > 0) {
        const randomIndex = Math.floor(Math.random() * players.length);
        const sheriff = players[randomIndex];
        sheriff.Properties.Get(ROLE_PROP_NAME).Value = ROLES.SHERIFF;
        sheriff.Properties.Get(CAN_KILL_PROP_NAME).Value = true;
    }
    
    // Выбираем медика (если включен)
    if (ENABLE_MEDIC && players.length > 0) {
        const randomIndex = Math.floor(Math.random() * players.length);
        const medic = players[randomIndex];
        medic.Properties.Get(ROLE_PROP_NAME).Value = ROLES.MEDIC;
    }
    
    return true;
}

// Настройка инвентаря
function setupInventory(player) {
    const inventory = Inventory.GetContext(player);
    const role = player.Properties.Get(ROLE_PROP_NAME).Value;
    
    inventory.Main.Value = true;
    inventory.Secondary.Value = true;
    inventory.Melee.Value = true;
    inventory.Explosive.Value = true;
    inventory.Build.Value = true;
    
    // Отключаем урон для мирных (кроме шерифа)
    if (role === ROLES.CREWMATE || role === ROLES.MEDIC) {
        Damage.GetContext(player).DamageOut.Value = false;
    } else {
        Damage.GetContext(player).DamageOut.Value = true;
    }
}

// Обработчик смерти
Damage.OnDeath.Add(function(player, killer) {
    if (stateProp.Value !== PLAY_STATE) return;
    
    player.Properties.Get(IS_ALIVE_PROP_NAME).Value = false;
    gameData.deadPlayers.add(player.Id);
    ghostTeam.Add(player);
    
    if (FREEZE_ON_DEATH) {
        player.Properties.MovementFreeze.Value = true;
    }
    
    // Если убийца - предатель
    if (killer && killer.Properties.Get(ROLE_PROP_NAME).Value === ROLES.IMPOSTER) {
        killer.Properties.Get(KILLS_PROP_NAME).Value += 1;
        killer.Timers.Get(KILL_COOLDOWN_TIMER).Restart(KILL_COOLDOWN);
    }
    
    checkWinConditions();
});

// Обработчик убийства
Damage.OnKill.Add(function(player, killed) {
    if (stateProp.Value !== PLAY_STATE) return;
    
    // Шериф может убивать, но если убил мирного - сам умирает
    if (player.Properties.Get(ROLE_PROP_NAME).Value === ROLES.SHERIFF && 
        killed.Properties.Get(ROLE_PROP_NAME).Value !== ROLES.IMPOSTER) {
        Damage.GetContext().Kill(player, player);
        Chat.Broadcast(`Шериф ${player.Name} убил невинного и был наказан!`);
    }
});

// Обработчик спавна
Spawns.OnSpawn.Add(function(player) {
    setupInventory(player);
    player.Properties.Immortality.Value = (stateProp.Value === LOBBY_STATE);
});

// Чат команды
function initChatCommands() {
    Chat.OnMessage.Add(function(m) {
        const msg = m.Text.trim();
        const sender = Players.GetByRoomId(m.Sender);
        if (!sender) return;

        // Мертвые игроки могут писать только в мертвый чат
        if (gameData.deadPlayers.has(sender.Id) {
            if (msg.startsWith('/dead')) {
                Chat.Broadcast(`[ПРИЗРАК] ${sender.Name}: ${msg.substring(5).trim()}`, 
                    { ReceiverFilter: Array.from(gameData.deadPlayers) });
            }
            return;
        }

        const args = msg.split(' ');
        const command = args[0].toLowerCase();

        if (command === '/help') {
            showHelp(sender);
        } 
        else if (command === '/kill' && stateProp.Value === PLAY_STATE) {
            handleKill(sender, args);
        }
        else if (command === '/meeting' && stateProp.Value === PLAY_STATE) {
            callMeeting(sender);
        }
        else if (command === '/vote' && stateProp.Value === PLAY_STATE) {
            handleVote(sender, args);
        }
        else if (command === '/revive' && stateProp.Value === PLAY_STATE && ENABLE_MEDIC) {
            handleRevive(sender, args);
        }
    });
}

function showHelp(player) {
    let helpMsg = `Доступные команды:
/meeting - экстренное собрание
/vote [id] - голосовать за изгнание
/dead [msg] - чат для мертвых`;

    if (player.Properties.Get(CAN_KILL_PROP_NAME).Value) {
        helpMsg += "\n/kill [id] - убить игрока";
    }
    if (player.Properties.Get(ROLE_PROP_NAME).Value === ROLES.MEDIC) {
        helpMsg += "\n/revive [id] - воскресить игрока";
    }

    player.Ui.Hint.Value = helpMsg;
}

function handleKill(player, args) {
    if (!player.Properties.Get(CAN_KILL_PROP_NAME).Value || 
        !player.Properties.Get(IS_ALIVE_PROP_NAME).Value ||
        args.length < 2) return;

    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    
    if (target && target.Properties.Get(IS_ALIVE_PROP_NAME).Value && 
        !player.Timers.Get(KILL_COOLDOWN_TIMER).IsRunning) {
        Damage.GetContext().Kill(player, target);
    }
}

function callMeeting(player) {
    if (!gameData.emergencyAvailable) {
        player.Ui.Hint.Value = "Кнопка собрания перезаряжается";
        return;
    }
    
    gameData.emergencyAvailable = false;
    gameData.meetingsCount++;
    startDiscussion();
    mainTimer.Restart(DISCUSSION_TIME);
    Timers.GetContext().Get("EmergencyCD").Restart(60);
}

function handleVote(player, args) {
    if (args.length < 2) return;
    
    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    
    if (target && target.Properties.Get(IS_ALIVE_PROP_NAME).Value) {
        // Здесь должна быть логика голосования
        // В демо-режиме просто исключаем игрока
        Damage.GetContext().Kill(target, target);
        Chat.Broadcast(`${player.Name} проголосовал против ${target.Name}`);
    }
}

function handleRevive(player, args) {
    if (player.Properties.Get(ROLE_PROP_NAME).Value !== ROLES.MEDIC || args.length < 2) return;
    
    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    
    if (target && gameData.deadPlayers.has(target.Id)) {
        target.Properties.Get(IS_ALIVE_PROP_NAME).Value = true;
        gameData.deadPlayers.delete(target.Id);
        crewTeam.Add(target);
        target.Properties.MovementFreeze.Value = false;
        Chat.Broadcast(`${player.Name} воскресил ${target.Name}!`);
    }
}

// Состояния игры
function startLobby() {
    stateProp.Value = LOBBY_STATE;
    Ui.GetContext().Hint.Value = `Ожидание игроков (минимум ${MIN_PLAYERS})...`;
    mainTimer.Restart(LOBBY_TIME);
    
    gameData = {
        deadPlayers: new Set(),
        reportedBodies: new Set(),
        killCooldowns: new Map(),
        meetingsCount: 0,
        emergencyAvailable: true
    };
    
    Players.All.forEach(initPlayer);
}

function startGame() {
    if (!assignRoles()) {
        startLobby();
        return;
    }
    
    stateProp.Value = PLAY_STATE;
    Ui.GetContext().Hint.Value = "Найдите и устраните предателей!";
    mainTimer.Restart(GAME_TIME);
    
    Players.All.forEach(player => {
        setupInventory(player);
        player.Properties.Immortality.Value = false;
    });
}

function startDiscussion() {
    stateProp.Value = DISCUSSION_STATE;
    Ui.GetContext().Hint.Value = "Обсуждение! Говорите, кого подозреваете.";
    
    Players.All.forEach(player => {
        player.Properties.MovementFreeze.Value = true;
    });
}

function endGame(winnerTeam) {
    stateProp.Value = GAME_OVER_STATE;
    
    if (winnerTeam === crewTeam) {
        Ui.GetContext().Hint.Value = "Мирные победили!";
    } else {
        Ui.GetContext().Hint.Value = "Предатели победили!";
    }
    
    Players.All.forEach(player => {
        Chat.Broadcast(`${player.Name} был ${player.Properties.Get(ROLE_PROP_NAME).Value}`);
    });
    
    mainTimer.Restart(10);
}

// Проверка условий победы
function checkWinConditions() {
    const aliveCrew = Array.from(Players.All).filter(p => 
        p.Properties.Get(IS_ALIVE_PROP_NAME).Value && 
        p.Properties.Get(ROLE_PROP_NAME).Value !== ROLES.IMPOSTER
    ).length;
    
    const aliveImposters = Array.from(Players.All).filter(p => 
        p.Properties.Get(IS_ALIVE_PROP_NAME).Value && 
        p.Properties.Get(ROLE_PROP_NAME).Value === ROLES.IMPOSTER
    ).length;
    
    if (aliveImposters === 0) {
        endGame(crewTeam);
    } 
    else if (aliveImposters >= aliveCrew) {
        endGame(imposterTeam);
    }
}

// Обработчик таймера
mainTimer.OnTimer.Add(function() {
    switch (stateProp.Value) {
        case LOBBY_STATE:
            startGame();
            break;
        case PLAY_STATE:
            endGame(crewTeam); // Если время вышло - победа мирных
            break;
        case DISCUSSION_STATE:
            // После обсуждения возвращаемся в игру
            startGame();
            break;
        case GAME_OVER_STATE:
            Game.Restart();
            break;
    }
});

// Обработчик кд кнопки собрания
Timers.GetContext().Get("EmergencyCD").OnTimer.Add(function() {
    gameData.emergencyAvailable = true;
    Chat.Broadcast("Кнопка собрания снова доступна!");
});

// Обработчик подключения игроков
Players.OnJoin.Add(function(player) {
    initPlayer(player);
    if (stateProp.Value === LOBBY_STATE) {
        crewTeam.Add(player);
    }
});

// Обработчик отключения игроков
Players.OnLeave.Add(function(player) {
    if (player.Properties.Get(ROLE_PROP_NAME).Value === ROLES.IMPOSTER) {
        checkWinConditions();
    }
});

// Инициализация чат-команд
initChatCommands();

// Начало игры
startLobby();
