import { DisplayValueHeader } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, Teams, Damage, Ui, Properties, GameMode, Spawns, Timers, Chat } from 'pixel_combats/room';

// Константы
const LOBBY_TIME = 20;
const GAME_TIME = 300;
const KILL_COOLDOWN = 30;
const MEETING_COOLDOWN = 60;

const LOBBY_STATE = "Lobby";
const PLAY_STATE = "Play";
const GAME_OVER_STATE = "GameOver";

const KILLS_PROP_NAME = "Kills";
const ROLE_PROP_NAME = "Role";
const IS_ALIVE_PROP_NAME = "IsAlive";
const CAN_KILL_PROP_NAME = "CanKill";

const ROLES = {
    CREWMATE: "Crewmate",
    IMPOSTER: "Imposter",
    SHERIFF: "Sheriff"
};

// Инициализация команд
const CREW_TEAM = Teams.Add("Crew", "Команда", new Color(0, 0, 1, 0));
const IMPOSTER_TEAM = Teams.Add("Imposter", "Предатель", new Color(1, 0, 0, 0));
const GHOST_TEAM = Teams.Add("Ghost", "Призрак", new Color(0.5, 0.5, 0.5, 0.5));

// Состояние игры
let gameState = {
    phase: LOBBY_STATE,
    deadPlayers: new Set(),
    imposter: null,
    sheriff: null,
    killCooldowns: new Map(),
    meetingAvailable: true
};

// Таймеры
const mainTimer = Timers.GetContext().Get("Main");
const meetingCooldownTimer = Timers.GetContext().Get("MeetingCD");

// Настройки из параметров
const IMPOSTERS_COUNT = 1;
const ENABLE_SHERIFF = true;

// Инициализация игрока
function initPlayer(player) {
    player.Properties.Get(KILLS_PROP_NAME).Value = 0;
    player.Properties.Get(ROLE_PROP_NAME).Value = ROLES.CREWMATE;
    player.Properties.Get(IS_ALIVE_PROP_NAME).Value = true;
    player.Properties.Get(CAN_KILL_PROP_NAME).Value = false;
    
    CREW_TEAM.Add(player);
    player.Timers.Get("KillCD").Stop();
}

// Распределение ролей
function assignRoles() {
    const players = Array.from(Players.All);
    if (players.length < 4) return false;

    // Выбираем предателя
    const imposterIndex = Math.floor(Math.random() * players.length);
    gameState.imposter = players[imposterIndex];
    gameState.imposter.Properties.Get(ROLE_PROP_NAME).Value = ROLES.IMPOSTER;
    gameState.imposter.Properties.Get(CAN_KILL_PROP_NAME).Value = true;
    IMPOSTER_TEAM.Add(gameState.imposter);

    // Убираем предателя из массива
    players.splice(imposterIndex, 1);

    // Выбираем шерифа (если включен)
    if (ENABLE_SHERIFF && players.length > 0) {
        const sheriffIndex = Math.floor(Math.random() * players.length);
        gameState.sheriff = players[sheriffIndex];
        gameState.sheriff.Properties.Get(ROLE_PROP_NAME).Value = ROLES.SHERIFF;
        gameState.sheriff.Properties.Get(CAN_KILL_PROP_NAME).Value = true;
    }

    return true;
}

// Настройка инвентаря
function setupInventory(player) {
    const inventory = Inventory.GetContext(player);
    inventory.Main.Value = true;
    inventory.Secondary.Value = true;
    inventory.Melee.Value = true;
    inventory.Explosive.Value = true;
    inventory.Build.Value = true;

    // Только предатель и шериф могут убивать
    Damage.GetContext(player).DamageOut.Value = 
        player.Properties.Get(CAN_KILL_PROP_NAME).Value;
}

// Обработчик смерти
Damage.OnDeath.Add(function(player, killer) {
    if (gameState.phase !== PLAY_STATE) return;
    
    player.Properties.Get(IS_ALIVE_PROP_NAME).Value = false;
    gameState.deadPlayers.add(player.Id);
    GHOST_TEAM.Add(player);
    
    // Если убийца - предатель
    if (killer && killer === gameState.imposter) {
        killer.Properties.Get(KILLS_PROP_NAME).Value += 1;
        killer.Timers.Get("KillCD").Restart(KILL_COOLDOWN);
    }
    
    checkWinConditions();
});

// Обработчик убийства
Damage.OnKill.Add(function(player, killed) {
    if (gameState.phase !== PLAY_STATE) return;
    
    // Шериф наказан за убийство мирного
    if (player === gameState.sheriff && killed !== gameState.imposter) {
        Damage.GetContext().Kill(player, player);
        Chat.Broadcast(`Шериф ${player.Name} убил невинного!`);
    }
});

// Чат команды
function initChatCommands() {
    Chat.OnMessage.Add(function(m) {
        const msg = m.Text.trim();
        const sender = Players.GetByRoomId(m.Sender);
        if (!sender) return;

        // Мертвые игроки могут писать только в мертвый чат
        if (gameState.deadPlayers.has(sender.Id)) {
            if (msg.startsWith('/dead')) {
                Chat.Broadcast(`[ПРИЗРАК] ${sender.Name}: ${msg.substring(5).trim()}`, 
                    { ReceiverFilter: Array.from(gameState.deadPlayers) });
            }
            return;
        }

        const args = msg.split(' ');
        const command = args[0].toLowerCase();

        if (command === '/help') {
            showHelp(sender);
        } 
        else if (command === '/kill' && gameState.phase === PLAY_STATE) {
            handleKill(sender, args);
        }
        else if (command === '/meeting' && gameState.phase === PLAY_STATE) {
            callMeeting(sender);
        }
        else if (command === '/vote' && gameState.phase === PLAY_STATE) {
            handleVote(sender, args);
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

    player.Ui.Hint.Value = helpMsg;
}

function handleKill(player, args) {
    if (!player.Properties.Get(CAN_KILL_PROP_NAME).Value || 
        !player.Properties.Get(IS_ALIVE_PROP_NAME).Value ||
        args.length < 2 ||
        player.Timers.Get("KillCD").IsRunning) return;

    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    
    if (target && target.Properties.Get(IS_ALIVE_PROP_NAME).Value) {
        Damage.GetContext().Kill(player, target);
    }
}

function callMeeting(player) {
    if (!gameState.meetingAvailable) {
        player.Ui.Hint.Value = "Кнопка собрания перезаряжается";
        return;
    }
    
    gameState.meetingAvailable = false;
    Chat.Broadcast(`${player.Name} созывает экстренное собрание!`);
    meetingCooldownTimer.Restart(MEETING_COOLDOWN);
}

function handleVote(player, args) {
    if (args.length < 2) return;
    
    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    
    if (target && target.Properties.Get(IS_ALIVE_PROP_NAME).Value) {
        // В демо-режиме сразу убиваем голосуемого
        Damage.GetContext().Kill(target, target);
        Chat.Broadcast(`${player.Name} проголосовал против ${target.Name}`);
    }
}

// Состояния игры
function startLobby() {
    gameState = {
        phase: LOBBY_STATE,
        deadPlayers: new Set(),
        imposter: null,
        sheriff: null,
        killCooldowns: new Map(),
        meetingAvailable: true
    };
    
    Properties.GetContext().Get("State").Value = LOBBY_STATE;
    Ui.GetContext().Hint.Value = "Ожидание игроков...";
    mainTimer.Restart(LOBBY_TIME);
    
    Players.All.forEach(initPlayer);
}

function startGame() {
    if (!assignRoles()) {
        startLobby();
        return;
    }
    
    gameState.phase = PLAY_STATE;
    Properties.GetContext().Get("State").Value = PLAY_STATE;
    Ui.GetContext().Hint.Value = "Найдите предателя!";
    mainTimer.Restart(GAME_TIME);
    
    Players.All.forEach(player => {
        setupInventory(player);
        player.Properties.Immortality.Value = false;
    });
}

function endGame(crewWins) {
    gameState.phase = GAME_OVER_STATE;
    Properties.GetContext().Get("State").Value = GAME_OVER_STATE;
    
    if (crewWins) {
        Ui.GetContext().Hint.Value = "Мирные победили!";
    } else {
        Ui.GetContext().Hint.Value = "Предатель победил!";
    }
    
    Chat.Broadcast(`Предатель был: ${gameState.imposter.Name}`);
    
    mainTimer.Restart(10);
}

// Проверка условий победы
function checkWinConditions() {
    const aliveCrew = Array.from(Players.All).filter(p => 
        p.Properties.Get(IS_ALIVE_PROP_NAME).Value && 
        p !== gameState.imposter
    ).length;
    
    if (!gameState.imposter.Properties.Get(IS_ALIVE_PROP_NAME).Value) {
        endGame(true);
    } 
    else if (aliveCrew <= 1) {
        endGame(false);
    }
}

// Обработчик таймера
mainTimer.OnTimer.Add(function() {
    switch (gameState.phase) {
        case LOBBY_STATE:
            startGame();
            break;
        case PLAY_STATE:
            endGame(true); // Если время вышло - победа мирных
            break;
        case GAME_OVER_STATE:
            Game.Restart();
            break;
    }
});

// Обработчик кд кнопки собрания
meetingCooldownTimer.OnTimer.Add(function() {
    gameState.meetingAvailable = true;
    Chat.Broadcast("Кнопка собрания снова доступна!");
});

// Обработчики игроков
Players.OnJoin.Add(function(player) {
    initPlayer(player);
    if (gameState.phase === LOBBY_STATE) {
        CREW_TEAM.Add(player);
    }
});

Players.OnLeave.Add(function(player) {
    if (player === gameState.imposter) {
        endGame(true);
    }
});

// Инициализация
function initialize() {
    LeaderBoard.PlayerLeaderBoardValues = [
        new DisplayValueHeader(KILLS_PROP_NAME, "Statistics/Kills", "Statistics/KillsShort"),
        new DisplayValueHeader(ROLE_PROP_NAME, "Statistics/Role", "Statistics/RoleShort")
    ];
    
    initChatCommands();
    startLobby();
}

initialize();
