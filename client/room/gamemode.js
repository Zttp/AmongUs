import { DisplayValueHeader } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, Teams, Damage, Ui, Properties, GameMode, Spawns, Timers, Chat } from 'pixel_combats/room';
import * as teams from './default_teams.js';
import * as default_timer from './default_timer.js';

// Настройки
const LOBBY_TIME = 30;
const DISCUSSION_TIME = 60;
const VOTING_TIME = 30;
const TASKS_TIME = default_timer.game_mode_length_seconds();
const EMERGENCY_MEETING_COOLDOWN = 30;

// Состояния игры
const LOBBY_STATE = "Lobby";
const TASKS_STATE = "Tasks";
const DISCUSSION_STATE = "Discussion";
const VOTING_STATE = "Voting";
const GAME_OVER_STATE = "GameOver";

// Константы
const IMMORTALITY_TIMER_NAME = "immortality";
const KILLS_PROP_NAME = "Kills";
const TASKS_PROP_NAME = "Tasks";
const ROLE_PROP_NAME = "Role";
const IS_ALIVE_PROP_NAME = "IsAlive";
const CAN_REPORT_PROP_NAME = "CanReport";
const CAN_USE_VENT_PROP_NAME = "CanUseVent";
const CAN_REVIVE_PROP_NAME = "CanRevive";
const CAN_KILL_PROP_NAME = "CanKill";

// Роли
const ROLES = {
    CREWMATE: "Crewmate",
    IMPOSTER: "Imposter",
    SHERIFF: "Sheriff",
    MEDIC: "Medic",
    ENGINEER: "Engineer"
};

// Получаем объекты
const mainTimer = Timers.GetContext().Get("Main");
const stateProp = Properties.GetContext().Get("State");
const emergencyCooldownTimer = Timers.GetContext().Get("EmergencyCD");

// Применяем параметры режима
const MIN_PLAYERS = GameMode.Parameters.GetNumber("MinPlayers");
const IMPOSTERS_COUNT = GameMode.Parameters.GetNumber("ImpostersCount");
const ENABLE_SHERIFF = GameMode.Parameters.GetBool("EnableSheriff");
const ENABLE_MEDIC = GameMode.Parameters.GetBool("EnableMedic");
const ENABLE_ENGINEER = GameMode.Parameters.GetBool("EnableEngineer");
const FREEZE_ON_DEATH = GameMode.Parameters.GetBool("FreezeOnDeath");

// Создаем команды
const { crewTeam, imposterTeam, ghostTeam } = teams.create_teams();

// Настройка лидерборда
LeaderBoard.PlayerLeaderBoardValues = [
    new DisplayValueHeader(KILLS_PROP_NAME, "Statistics/Kills", "Statistics/KillsShort"),
    new DisplayValueHeader(TASKS_PROP_NAME, "Statistics/Tasks", "Statistics/TasksShort"),
    new DisplayValueHeader(ROLE_PROP_NAME, "Statistics/Role", "Statistics/RoleShort")
];

// Переменные режима
let gameData = {
    bodies: new Map(),
    deadPlayers: new Set(),
    reportedBodies: new Set(),
    emergencyButtonUsable: true,
    meetingsCount: 0,
    totalTasks: 0,
    completedTasks: 0
};

// Инициализация игрока
function initPlayer(player) {
    player.Properties.Get(KILLS_PROP_NAME).Value = 0;
    player.Properties.Get(TASKS_PROP_NAME).Value = 0;
    player.Properties.Get(ROLE_PROP_NAME).Value = ROLES.CREWMATE;
    player.Properties.Get(IS_ALIVE_PROP_NAME).Value = true;
    player.Properties.Get(CAN_REPORT_PROP_NAME).Value = true;
    player.Properties.Get(CAN_USE_VENT_PROP_NAME).Value = false;
    player.Properties.Get(CAN_REVIVE_PROP_NAME).Value = false;
    player.Properties.Get(CAN_KILL_PROP_NAME).Value = false;
    
    // Добавляем в команду мирных (позже будет перераспределение)
    crewTeam.Add(player);
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
        imposter.Properties.Get(CAN_USE_VENT_PROP_NAME).Value = true;
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
        medic.Properties.Get(CAN_REVIVE_PROP_NAME).Value = true;
    }
    
    // Выбираем инженера (если включен)
    if (ENABLE_ENGINEER && players.length > 0) {
        const randomIndex = Math.floor(Math.random() * players.length);
        const engineer = players[randomIndex];
        engineer.Properties.Get(ROLE_PROP_NAME).Value = ROLES.ENGINEER;
        engineer.Properties.Get(CAN_USE_VENT_PROP_NAME).Value = true;
    }
    
    // Остальные - обычные члены команды
    players.forEach(player => {
        player.Properties.Get(ROLE_PROP_NAME).Value = ROLES.CREWMATE;
    });
    
    return true;
}

// Настройка инвентаря по роли
function setupInventory(player) {
    const inventory = Inventory.GetContext(player);
    const role = player.Properties.Get(ROLE_PROP_NAME).Value;
    
    inventory.Main.Value = true;  // Основное оружие
    inventory.Secondary.Value = true;  // Вторичное оружие
    inventory.Melee.Value = true;  // Ближний бой
    inventory.Explosive.Value = true;  // Взрывчатка
    inventory.Build.Value = true;  // Строительство
    
    // Отключаем урон для мирных (кроме шерифа)
    if (role === ROLES.CREWMATE || role === ROLES.MEDIC || role === ROLES.ENGINEER) {
        Damage.GetContext(player).DamageOut.Value = false;
    } else {
        Damage.GetContext(player).DamageOut.Value = true;
    }
}

// Обработчик смерти
Damage.OnDeath.Add(function(player, killer) {
    if (stateProp.Value !== TASKS_STATE) return;
    
    // Помечаем игрока как мертвого
    player.Properties.Get(IS_ALIVE_PROP_NAME).Value = false;
    gameData.deadPlayers.add(player.Id);
    
    // Если есть убийца и это предатель
    if (killer && killer.Properties.Get(ROLE_PROP_NAME).Value === ROLES.IMPOSTER) {
        killer.Properties.Get(KILLS_PROP_NAME).Value += 1;
    }
    
    // Переносим в команду призраков
    ghostTeam.Add(player);
    
    // Замораживаем игрока (если включено)
    if (FREEZE_ON_DEATH) {
        player.Properties.MovementFreeze.Value = true;
    }
    
    // Создаем тело для репортов
    const bodyId = generateBodyId();
    gameData.bodies.set(bodyId, {
        player: player,
        position: player.Position,
        killer: killer
    });
    
    // Проверяем условия победы
    checkWinConditions();
});

// Обработчик убийства
Damage.OnKill.Add(function(player, killed) {
    if (stateProp.Value !== TASKS_STATE) return;
    
    // Шериф может убивать, но если убил мирного - сам становится призраком
    if (player.Properties.Get(ROLE_PROP_NAME).Value === ROLES.SHERIFF && 
        killed.Properties.Get(ROLE_PROP_NAME).Value !== ROLES.IMPOSTER) {
        Damage.GetContext().Kill(player, player);
        Chat.Broadcast(`Шериф ${player.Name} убил невинного и был наказан!`);
    }
});

// Обработчик спавна
Spawns.OnSpawn.Add(function(player) {
    if (stateProp.Value === LOBBY_STATE) {
        player.Properties.Immortality.Value = true;
    } else {
        player.Properties.Immortality.Value = false;
    }
    
    // Настраиваем инвентарь по роли
    setupInventory(player);
});

// Чат команды
function initChatCommands() {
    Chat.OnMessage.Add(function(m) {
        const msg = m.Text.trim();
        const sender = Players.GetByRoomId(m.Sender);
        if (!sender) return;

        // Мертвые игроки могут писать только в мертвый чат
        if (gameData.deadPlayers.has(sender.Id) && !msg.startsWith('/dead')) {
            return;
        }

        const args = msg.split(' ');
        const command = args[0].toLowerCase();

        if (command === '/help') {
            showHelp(sender);
        } else if (command === '/report') {
            handleReport(sender, args);
        } else if (command === '/meeting') {
            callMeeting(sender);
        } else if (command === '/vote') {
            handleVote(sender, args);
        } else if (command === '/taskinfo') {
            showTasks(sender);
        } else if (command === '/complete') {
            completeTask(sender);
        } else if (command === '/dead') {
            deadChat(sender, msg.substring('/dead'.length).trim());
        } else if (command === '/kill') {
            handleKill(sender, args);
        } else if (command === '/vent') {
            handleVent(sender);
        } else if (command === '/revive') {
            handleRevive(sender, args);
        }
    });
}

// Функции чат-команд
function showHelp(player) {
    let helpMsg = `Доступные команды:
/report [id] - сообщить о теле
/meeting - экстренное собрание
/vote [id] - голосовать за изгнание
/taskinfo - мои задания
/complete - выполнить задание
/dead [msg] - чат для мертвых`;

    if (player.Properties.Get(CAN_KILL_PROP_NAME).Value) {
        helpMsg += "\n/kill [id] - убить игрока (предатель/шериф)";
    }
    if (player.Properties.Get(CAN_USE_VENT_PROP_NAME).Value) {
        helpMsg += "\n/vent - использовать вентиляцию";
    }
    if (player.Properties.Get(CAN_REVIVE_PROP_NAME).Value) {
        helpMsg += "\n/revive [id] - воскресить игрока";
    }

    player.Ui.Hint.Value = helpMsg;
}

function handleReport(player, args) {
    if (stateProp.Value !== TASKS_STATE || !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;
    if (args.length < 2) {
        player.Ui.Hint.Value = "Использование: /report [id тела]";
        return;
    }

    const bodyId = Number(args[1]);
    if (gameData.bodies.has(bodyId) && !gameData.reportedBodies.has(bodyId)) {
        gameData.reportedBodies.add(bodyId);
        startDiscussion();
    }
}

function callMeeting(player) {
    if (stateProp.Value !== TASKS_STATE || !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;
    if (!gameData.emergencyButtonUsable) {
        player.Ui.Hint.Value = "Кнопка экстренного собрания перезаряжается";
        return;
    }

    startDiscussion();
    gameData.emergencyButtonUsable = false;
    emergencyCooldownTimer.Restart(EMERGENCY_MEETING_COOLDOWN);
}

function handleVote(player, args) {
    if (stateProp.Value !== VOTING_STATE || !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;
    if (args.length < 2) {
        player.Ui.Hint.Value = "Использование: /vote [id игрока]";
        return;
    }

    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    if (target) {
        // Логика голосования
        // ...
    }
}

function showTasks(player) {
    if (player.Properties.Get(ROLE_PROP_NAME).Value === ROLES.IMPOSTER) {
        player.Ui.Hint.Value = "Ваша задача - убивать членов экипажа и саботировать корабль!";
    } else {
        player.Ui.Hint.Value = `Ваши задания: ${player.Properties.Get(TASKS_PROP_NAME).Value}/3 выполнено`;
    }
}

function completeTask(player) {
    if (stateProp.Value !== TASKS_STATE || 
        player.Properties.Get(ROLE_PROP_NAME).Value === ROLES.IMPOSTER ||
        !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;

    const tasks = player.Properties.Get(TASKS_PROP_NAME).Value + 1;
    player.Properties.Get(TASKS_PROP_NAME).Value = tasks;
    gameData.completedTasks += 1;

    if (tasks >= 3) {
        player.Ui.Hint.Value = "Все задания выполнены!";
    } else {
        player.Ui.Hint.Value = `Задание выполнено! Осталось ${3 - tasks}`;
    }

    checkWinConditions();
}

function deadChat(player, message) {
    if (!gameData.deadPlayers.has(player.Id)) return;
    Chat.Broadcast(`[ПРИЗРАК] ${player.Name}: ${message}`, { ReceiverFilter: Array.from(gameData.deadPlayers) });
}

function handleKill(player, args) {
    if (stateProp.Value !== TASKS_STATE || 
        !player.Properties.Get(CAN_KILL_PROP_NAME).Value ||
        !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;
    
    if (args.length < 2) {
        player.Ui.Hint.Value = "Использование: /kill [id игрока]";
        return;
    }

    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    if (target && target.Properties.Get(IS_ALIVE_PROP_NAME).Value) {
        Damage.GetContext().Kill(player, target);
    }
}

function handleVent(player) {
    if (stateProp.Value !== TASKS_STATE || 
        !player.Properties.Get(CAN_USE_VENT_PROP_NAME).Value ||
        !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;
    
    // Логика использования вентиляции
    // ...
}

function handleRevive(player, args) {
    if (stateProp.Value !== TASKS_STATE || 
        !player.Properties.Get(CAN_REVIVE_PROP_NAME).Value ||
        !player.Properties.Get(IS_ALIVE_PROP_NAME).Value) return;
    
    if (args.length < 2) {
        player.Ui.Hint.Value = "Использование: /revive [id игрока]";
        return;
    }

    const targetId = Number(args[1]);
    const target = Players.Get(targetId);
    if (target && gameData.deadPlayers.has(target.Id)) {
        // Воскрешение игрока
        target.Properties.Get(IS_ALIVE_PROP_NAME).Value = true;
        gameData.deadPlayers.delete(target.Id);
        crewTeam.Add(target);
        target.Properties.MovementFreeze.Value = false;
        player.Properties.Get(CAN_REVIVE_PROP_NAME).Value = false;
        
        Chat.Broadcast(`${player.Name} воскресил ${target.Name}!`);
    }
}

// Состояния игры
function startLobby() {
    stateProp.Value = LOBBY_STATE;
    Ui.GetContext().Hint.Value = "Ожидание игроков...";
    mainTimer.Restart(LOBBY_TIME);
    
    // Сброс данных игры
    gameData = {
        bodies: new Map(),
        deadPlayers: new Set(),
        reportedBodies: new Set(),
        emergencyButtonUsable: true,
        meetingsCount: 0,
        totalTasks: 0,
        completedTasks: 0
    };
    
    // Инициализация игроков
    Players.All.forEach(player => {
        initPlayer(player);
        crewTeam.Add(player);
    });
}

function startTasks() {
    if (!assignRoles()) {
        startLobby();
        return;
    }
    
    stateProp.Value = TASKS_STATE;
    Ui.GetContext().Hint.Value = "Выполняйте задания и следите за предателями!";
    mainTimer.Restart(TASKS_TIME);
    
    // Настройка инвентаря для всех игроков
    Players.All.forEach(player => {
        setupInventory(player);
        player.Properties.Immortality.Value = false;
    });
    
    // Установка заданий
    gameData.totalTasks = Players.All.length * 3;
}

function startDiscussion() {
    stateProp.Value = DISCUSSION_STATE;
    Ui.GetContext().Hint.Value = "Обсуждение! Говорите, кого подозреваете.";
    mainTimer.Restart(DISCUSSION_TIME);
    
    // Замораживаем всех игроков
    Players.All.forEach(player => {
        player.Properties.MovementFreeze.Value = true;
    });
}

function startVoting() {
    stateProp.Value = VOTING_STATE;
    Ui.GetContext().Hint.Value = "Голосование! Используйте /vote [id].";
    mainTimer.Restart(VOTING_TIME);
}

function endGame(winnerTeam) {
    stateProp.Value = GAME_OVER_STATE;
    
    if (winnerTeam === crewTeam) {
        Ui.GetContext().Hint.Value = "Мирные победили!";
    } else if (winnerTeam === imposterTeam) {
        Ui.GetContext().Hint.Value = "Предатели победили!";
    } else {
        Ui.GetContext().Hint.Value = "Ничья!";
    }
    
    // Показываем роли всех игроков
    Players.All.forEach(player => {
        Chat.Broadcast(`${player.Name} был ${player.Properties.Get(ROLE_PROP_NAME).Value}`);
    });
    
    mainTimer.Restart(10);
}

// Проверка условий победы
function checkWinConditions() {
    // Проверяем победу предателей
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
        return;
    }
    
    if (aliveImposters >= aliveCrew) {
        endGame(imposterTeam);
        return;
    }
    
    // Проверяем победу через задания
    if (gameData.completedTasks >= gameData.totalTasks * 0.75) {
        endGame(crewTeam);
        return;
    }
}

// Обработчик таймера
mainTimer.OnTimer.Add(function() {
    switch (stateProp.Value) {
        case LOBBY_STATE:
            startTasks();
            break;
        case TASKS_STATE:
            // Если время вышло, мирные побеждают
            endGame(crewTeam);
            break;
        case DISCUSSION_STATE:
            startVoting();
            break;
        case VOTING_STATE:
            startTasks();
            break;
        case GAME_OVER_STATE:
            Game.Restart();
            break;
    }
});

// Обработчик кд кнопки собрания
emergencyCooldownTimer.OnTimer.Add(function() {
    gameData.emergencyButtonUsable = true;
    Chat.Broadcast("Кнопка экстренного собрания снова доступна!");
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

// Генерация ID для тела
function generateBodyId() {
    return Math.floor(Math.random() * 1000000);
}

// Инициализация чат-команд
initChatCommands();

// Начало игры
startLobby();
