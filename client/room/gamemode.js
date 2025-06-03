import { DisplayValueHeader, Color, Vector3 } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, BuildBlocksSet, Teams, Damage, BreackGraph, Ui, Properties, GameMode, Spawns, Timers, TeamsBalancer, AreaService, AreaPlayerTriggerService, AreaViewService, Chat } from 'pixel_combats/room';

// Настройки режима через конструктор
const FRIENDLY_FIRE = GameMode.Parameters.GetBool("FriendlyFire");
const IMPOSTOR_COUNT = GameMode.Parameters.GetInt("ImpostorCount") || 1;
const SHERIFF_ENABLED = GameMode.Parameters.GetBool("SheriffEnabled");
const PLAYERS_TO_START = GameMode.Parameters.GetInt("PlayersToStart") || 1;
const TASKS_PER_PLAYER = GameMode.Parameters.GetInt("TasksPerPlayer") || 3;
const KILL_COOLDOWN = GameMode.Parameters.GetInt("KillCooldown") || 30;
const DISCUSSION_TIME = GameMode.Parameters.GetInt("DiscussionTime") || 90;
const VOTING_TIME = GameMode.Parameters.GetInt("VotingTime") || 60;

// Константы
const WAITING_TIME = 10;
const GAME_TIME = 600;
const END_TIME = 30;

// Цвета
const crewColor = new Color(0, 0.5, 1, 0.5); // Голубой - экипаж
const ghostColor = new Color(0.5, 0.5, 0.5, 0.5); // Серый - призраки
const impostorColor = new Color(1, 0, 0, 0.5); // Красный - предатель

// Контексты
const Inv = Inventory.GetContext();
const Sp = Spawns.GetContext();
const Dmg = Damage.GetContext();
const Props = Properties.GetContext();

// Состояния игры
const GameStates = {
    WAITING: "WaitingPlayers",
    STARTING: "Starting",
    TASKS: "TasksPhase",
    DISCUSSION: "Discussion",
    VOTING: "Voting",
    END: "EndGame"
};

// Таймеры
const mainTimer = Timers.GetContext().Get("Main");
const roundTimer = Timers.GetContext().Get("Round");
const killCooldownTimer = Timers.GetContext().Get("KillCD");

// Глобальные переменные
const gameMode = {
    state: GameStates.WAITING,
    impostors: new Set(),
    sheriff: null,
    ghosts: new Set(),
    deadPlayers: new Set(),
    playerRoles: new Map(),
    tasks: [],
    completedTasks: 0,
    totalTasks: 0,
    bodiesReported: new Set(),
    emergencyButtonUsed: false,
    sabotageActive: false,
    killCooldowns: new Map(),
    meetingInProgress: false,
    votes: new Map(),
    adminId: "D411BD94CAE31F89"
};

// Инициализация сервера
function initServerProperties() {
    Props.Get('Time_Seconds').Value = 0;
    Props.Get('Players_Now').Value = 0;
    Props.Get('Game_State').Value = gameMode.state;
    Props.Get('Tasks_Completed').Value = 0;
    Props.Get('Total_Tasks').Value = 0;
    Props.Get('Impostor_Count').Value = IMPOSTOR_COUNT;
}

// Создание команд
function setupTeams() {
    Teams.Add('Crew', 'Экипаж', crewColor);
    Teams.Add('Ghosts', 'Призраки', ghostColor);
    
    const CrewTeam = Teams.Get('Crew');
    const GhostsTeam = Teams.Get('Ghosts');

    // Настройки спавнов
    CrewTeam.Spawns.SpawnPointsGroups.Add(1);
    GhostsTeam.Spawns.SpawnPointsGroups.Add(2);

    return { CrewTeam, GhostsTeam };
}

const { CrewTeam, GhostsTeam } = setupTeams();

// Управление состоянием игры
function setGameState(newState) {
    gameMode.state = newState;
    Props.Get('Game_State').Value = newState;
    
    switch(newState) {
        case GameStates.WAITING:
            stateProp.Value = WAITING_TIME;
            Ui.GetContext().Hint.Value = `Ожидание игроков (минимум ${PLAYERS_TO_START})`;
            Sp.Enable = false;
            mainTimer.Restart(WAITING_TIME);
            break;
            
        case GameStates.STARTING:
            Ui.GetContext().Hint.Value = "Подготовка к запуску...";
            assignRoles();
            generateTasks();
            mainTimer.Restart(5);
            break;
            
        case GameStates.TASKS:
            stateProp.Value = GAME_TIME;
            Ui.GetContext().Hint.Value = "Выполняйте задания!";
            Inv.Main.Value = false;
            Inv.Secondary.Value = false;
            Inv.Melee.Value = true;
            Inv.Build.Value = false;
            Dmg.DamageOut.Value = true;
            Sp.Enable = true;
            Sp.Spawn();
            startRoundTimer();
            break;
            
        case GameStates.DISCUSSION:
            stateProp.Value = DISCUSSION_TIME;
            Ui.GetContext().Hint.Value = "Обсуждение! Говорите в чате!";
            freezeAllPlayers();
            mainTimer.Restart(DISCUSSION_TIME);
            break;
            
        case GameStates.VOTING:
            stateProp.Value = VOTING_TIME;
            Ui.GetContext().Hint.Value = "Голосование! Используйте /vote [id]";
            mainTimer.Restart(VOTING_TIME);
            break;
            
        case GameStates.END:
            stateProp.Value = END_TIME;
            Ui.GetContext().Hint.Value = "Игра окончена!";
            Sp.Enable = false;
            mainTimer.Restart(END_TIME);
            break;
    }
}

// Распределение ролей
function assignRoles() {
    const players = Players.All;
    
    // Выбор предателей
    const impostorIndices = [];
    while (impostorIndices.length < IMPOSTOR_COUNT) {
        const idx = Math.floor(Math.random() * players.length);
        if (!impostorIndices.includes(idx)) impostorIndices.push(idx);
    }
    
    // Выбор шерифа (если включен)
    let sheriffIdx = -1;
    if (SHERIFF_ENABLED && players.length > 3) {
        do {
            sheriffIdx = Math.floor(Math.random() * players.length);
        } while (impostorIndices.includes(sheriffIdx));
    }
    
    // Назначение ролей
    players.forEach((player, index) => {
        if (impostorIndices.includes(index)) {
            gameMode.impostors.add(player.id);
            gameMode.playerRoles.set(player.id, "Предатель");
            player.Properties.Get('Role').Value = "Предатель";
            player.Ui.Hint.Value = "ТЫ ПРЕДАТЕЛЬ! Убивай экипаж и саботируй системы!";
        } else if (index === sheriffIdx) {
            gameMode.sheriff = player.id;
            gameMode.playerRoles.set(player.id, "Шериф");
            player.Properties.Get('Role').Value = "Шериф";
            player.Ui.Hint.Value = "ТЫ ШЕРИФ! Ищи предателей и защищай экипаж!";
        } else {
            gameMode.playerRoles.set(player.id, "Экипаж");
            player.Properties.Get('Role').Value = "Экипаж";
            player.Ui.Hint.Value = "ТЫ ЧЛЕН ЭКИПАЖА! Выполняй задания и выявляй предателей!";
        }
    });
}

// Генерация заданий
function generateTasks() {
    gameMode.tasks = [
        { id: 1, name: "Починить проводку", location: "Электричество" },
        { id: 2, name: "Загрузить данные", location: "Оружейная" },
        { id: 3, name: "Сканировать документы", location: "Офис" },
        { id: 4, name: "Заправить двигатель", location: "Двигатели" },
        { id: 5, name: "Калибровка навигации", location: "Навигация" }
    ];
    
    gameMode.completedTasks = 0;
    gameMode.totalTasks = TASKS_PER_PLAYER * CrewTeam.Players.length;
    Props.Get('Total_Tasks').Value = gameMode.totalTasks;
}

// Система убийств
function handleKill(killer, victim) {
    if (!killer || !victim) return;
    
    // Проверка ролей
    const killerRole = gameMode.playerRoles.get(killer.id);
    const victimRole = gameMode.playerRoles.get(victim.id);
    
    // Предатель убивает члена экипажа или шерифа
    if (killerRole === "Предатель" && (victimRole === "Экипаж" || victimRole === "Шериф")) {
        // Перемещение в команду призраков
        CrewTeam.Remove(victim);
        GhostsTeam.Add(victim);
        gameMode.ghosts.add(victim.id);
        gameMode.deadPlayers.add(victim.id);
        
        // Настройки для призрака
        victim.Properties.Get('Alive').Value = false;
        victim.Ui.Hint.Value = "ТЫ УМЕР! Теперь ты призрак.";
        victim.contextedProperties.SkinType.Value = 4; // Специальный скин
        
        // Оповещение
        Chat.Send(`⚰️ ${victim.NickName} был убит!`);
        
        // Тело для обнаружения
        gameMode.bodiesReported.add(victim.id);
        
        // Установка перезарядки убийства
        gameMode.killCooldowns.set(killer.id, KILL_COOLDOWN);
        killer.Ui.Hint.Value = `Убийство! Перезарядка: ${KILL_COOLDOWN} сек`;
    }
    
    // Шериф пытается убить
    else if (killerRole === "Шериф") {
        // Если шериф попал в предателя
        if (victimRole === "Предатель") {
            CrewTeam.Remove(victim);
            GhostsTeam.Add(victim);
            gameMode.ghosts.add(victim.id);
            gameMode.deadPlayers.add(victim.id);
            victim.Properties.Get('Alive').Value = false;
            Chat.Send(`🎯 ${victim.NickName} был разоблачен шерифом!`);
        } 
        // Если шериф ошибся
        else {
            CrewTeam.Remove(killer);
            GhostsTeam.Add(killer);
            gameMode.ghosts.add(killer.id);
            gameMode.deadPlayers.add(killer.id);
            killer.Properties.Get('Alive').Value = false;
            Chat.Send(`💥 ${killer.NickName} ошибся и был наказан!`);
        }
    }
}

// Система заданий
function completeTask(player, taskId) {
    const task = gameMode.tasks.find(t => t.id === taskId);
    if (task) {
        gameMode.completedTasks++;
        Props.Get('Tasks_Completed').Value = gameMode.completedTasks;
        
        player.Properties.Scores.Value += 100;
        player.Ui.Hint.Value = `✅ ${task.name} выполнено!`;
        
        // Проверка победы экипажа
        if (gameMode.completedTasks >= gameMode.totalTasks) {
            endGame('crew');
        }
    }
}

// Обнаружение тела
function reportBody(reporter, bodyId) {
    if (!gameMode.bodiesReported.has(bodyId)) {
        gameMode.bodiesReported.add(bodyId);
        startMeeting(reporter, `Обнаружено тело ${Players.Get(bodyId).NickName}`);
    }
}

// Экстренное собрание
function emergencyMeeting(caller) {
    if (!gameMode.emergencyButtonUsed) {
        gameMode.emergencyButtonUsed = true;
        startMeeting(caller, "Экстренное собрание!");
    }
}

// Начало собрания
function startMeeting(caller, reason) {
    gameMode.meetingInProgress = true;
    gameMode.votes.clear();
    Chat.Send(`🚨 ${reason} Начинается обсуждение!`);
    setGameState(GameStates.DISCUSSION);
}

// Голосование
function castVote(voterId, targetId) {
    if (gameMode.state !== GameStates.VOTING) return;
    if (gameMode.deadPlayers.has(voterId)) return;
    
    gameMode.votes.set(voterId, targetId);
}

// Обработка результатов голосования
function processVotes() {
    const voteCount = new Map();
    
    // Подсчет голосов
    gameMode.votes.forEach((targetId, voterId) => {
        if (!voteCount.has(targetId)) voteCount.set(targetId, 0);
        voteCount.set(targetId, voteCount.get(targetId) + 1);
    });
    
    // Поиск игрока с максимальными голосами
    let maxVotes = 0;
    let ejectedPlayer = null;
    
    voteCount.forEach((votes, playerId) => {
        if (votes > maxVotes) {
            maxVotes = votes;
            ejectedPlayer = playerId;
        }
    });
    
    // Изгнание игрока
    if (ejectedPlayer && maxVotes > 0) {
        const player = Players.Get(ejectedPlayer);
        CrewTeam.Remove(player);
        GhostsTeam.Add(player);
        gameMode.ghosts.add(player.id);
        gameMode.deadPlayers.add(player.id);
        player.Properties.Get('Alive').Value = false;
        
        // Проверка роли изгнанного
        const role = gameMode.playerRoles.get(player.id);
        Chat.Send(`🗳️ ${player.NickName} изгнан! Роль: ${role}`);
        
        // Если изгнан предатель
        if (role === "Предатель") {
            gameMode.impostors.delete(player.id);
            
            // Проверка победы
            if (gameMode.impostors.size === 0) {
                endGame('crew');
            }
        }
    }
    
    gameMode.meetingInProgress = false;
}

// Конец игры
function endGame(winner) {
    let message = "";
    
    if (winner === 'crew') {
        message = "Экипаж побеждает! Задания выполнены!";
        CrewTeam.Players.forEach(player => {
            player.Properties.Scores.Value += 1000;
        });
    } 
    else if (winner === 'impostors') {
        message = "Предатели побеждают!";
        Players.All.forEach(player => {
            if (gameMode.impostors.has(player.id)) {
                player.Properties.Scores.Value += 1500;
            }
        });
    }
    
    Ui.GetContext().Hint.Value = message;
    Chat.Send(`🏆 ${message}`);
    setGameState(GameStates.END);
}

// Система саботажа
function sabotageSystem(saboteur, systemType) {
    if (!gameMode.impostors.has(saboteur.id)) return;
    
    gameMode.sabotageActive = true;
    let message = "";
    
    switch(systemType) {
        case 'lights':
            message = "САБОТАЖ: Отключено освещение!";
            break;
        case 'oxygen':
            message = "САБОТАЖ: Утечка кислорода!";
            break;
        case 'reactor':
            message = "САБОТАЖ: Перегрев реактора!";
            break;
    }
    
    Chat.Send(`🔥 ${message}`);
    mainTimer.Restart(60); // Время на устранение
    
    // Если саботаж не устранен вовремя
    mainTimer.OnTimer.Add(() => {
        if (gameMode.sabotageActive) {
            endGame('impostors');
        }
    });
}

// Инициализация игрока
function initPlayer(player) {
    player.Properties.Get('Role').Value = 'Не назначена';
    player.Properties.Get('Alive').Value = true;
    player.Properties.Get('TasksDone').Value = 0;
    player.Properties.Get('Kills').Value = 0;
    
    player.inventory.Main.Value = false;
    player.inventory.Secondary.Value = false;
    player.inventory.Melee.Value = true;
    
    // Назначение команды
    if (gameMode.state === GameStates.WAITING) {
        CrewTeam.Add(player);
    }
}

// Команды чата
function initChatCommands() {
    Chat.OnMessage.Add(function(m) {
        const msg = m.Text.trim();
        const sender = Players.GetByRoomId(m.Sender);
        if (!sender) return;

        // Мертвые игроки могут писать только в мертвый чат
        if (gameMode.deadPlayers.has(sender.id) && !msg.startsWith('/dead')) {
            return;
        }

        const args = msg.split(' ');
        const command = args[0].toLowerCase();

        if (command === '/help') {
            sender.Ui.Hint.Value = `Доступные команды:
/report [id] - сообщить о теле
/meeting - экстренное собрание
/sabotage [system] - саботаж (предатель)
/vote [id] - голосовать за изгнание
/taskinfo - мои задания
/complete - выполнить задание
/dead [msg] - чат для мертвых`;
        }
        
        else if (command === '/report') {
            if (args.length < 2) return;
            const bodyId = Number(args[1]);
            if (gameMode.bodiesReported.has(bodyId)) {
                reportBody(sender, bodyId);
            }
        }
        
        else if (command === '/meeting') {
            emergencyMeeting(sender);
        }
        
        else if (command === '/sabotage') {
            if (args.length < 2) return;
            sabotageSystem(sender, args[1]);
        }
        
        else if (command === '/vote') {
            if (args.length < 2) return;
            const targetId = Number(args[1]);
            castVote(sender.id, targetId);
        }
        
        else if (command === '/taskinfo') {
            const tasks = gameMode.tasks.filter(t => !t.completed);
            let taskList = "Ваши задания:\n";
            tasks.forEach(task => {
                taskList += `- ${task.name} (${task.location})\n`;
            });
            sender.Ui.Hint.Value = taskList;
        }
        
        else if (command === '/complete') {
            // Проверка зоны выполнения
            if (checkInTaskZone(sender)) {
                const task = gameMode.tasks.find(t => !t.completed);
                if (task) {
                    completeTask(sender, task.id);
                }
            }
        }
        
        else if (command === '/dead') {
            const deadMessage = msg.substring(6);
            Players.All.forEach(p => {
                if (gameMode.deadPlayers.has(p.id)) {
                    p.Ui.Hint.Value = `👻 ${sender.NickName}: ${deadMessage}`;
                }
            });
        }
    });
}

// Настройка лидерборда
function setupLeaderboard() {
    LeaderBoard.PlayerLeaderBoardValues = [
        new DisplayValueHeader('Role', 'Роль', 'Роль'),
        new DisplayValueHeader('Alive', 'Статус', 'Жив/Мертв'),
        new DisplayValueHeader('TasksDone', 'Задания', 'Выполнено'),
        new DisplayValueHeader('Kills', 'Убийства', 'Убийства')
    ];

    LeaderBoard.PlayersWeightGetter.Set(function(p) {
        return p.Properties.Get('TasksDone').Value + p.Properties.Get('Kills').Value * 2;
    });
}

// Обработчики событий
function setupEventHandlers() {
    Players.OnPlayerConnected.Add(function(player) {
        initPlayer(player);
        
        if (Players.All.length >= PLAYERS_TO_START && gameMode.state === GameStates.WAITING) {
            setGameState(GameStates.STARTING);
        }
    });
    
    
    Damage.OnDeath.Add(function(player) {
        player.Properties.Get('Alive').Value = false;
    });
    
    mainTimer.OnTimer.Add(function() {
        switch(gameMode.state) {
            case GameStates.WAITING:
                if (Players.All.length >= PLAYERS_TO_START) {
                    setGameState(GameStates.STARTING);
                }
                break;
                
            case GameStates.STARTING:
                setGameState(GameStates.TASKS);
                break;
                
            case GameStates.DISCUSSION:
                setGameState(GameStates.VOTING);
                break;
                
            case GameStates.VOTING:
                processVotes();
                setGameState(GameStates.TASKS);
                break;
                
            case GameStates.END:
                Game.RestartGame();
                break;
        }
    });
}

// Инициализация режима
function initGameMode() {
    Dmg.DamageOut.Value = true;
    Dmg.FriendlyFire.Value = FRIENDLY_FIRE;
    BreackGraph.OnlyPlayerBlocksDmg = true;
    
    initServerProperties();
    setupLeaderboard();
    initChatCommands();
    setupEventHandlers();
    setGameState(GameStates.WAITING);
}

initGameMode();
