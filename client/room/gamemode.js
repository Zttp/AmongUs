import { DisplayValueHeader, Color, Vector3 } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, Teams, Damage, Ui, Properties, GameMode, Spawns, Timers, Chat } from 'pixel_combats/room';
import { BotsService } from 'pixel_combats/room/services/bots';

// ========== КОНСТАНТЫ И НАСТРОЙКИ ==========
const WAITING_TIME = 15;      // Ожидание игроков (сек)
const DISCUSSION_TIME = 120;  // Время обсуждения (сек)
const VOTING_TIME = 30;       // Время голосования (сек)
const PLAY_TIME = 600;        // Время игры (сек)
const END_TIME = 30;          // Время окончания (сек)

// Цвета команд
const PLAYERS_COLOR = new Color(0, 0.5, 1, 0);     // Синий
const LOSERS_COLOR = new Color(0.3, 0.3, 0.3, 0);  // Серый

// Состояния игры
const GameStates = {
    WAITING: "WaitingPlayers",
    PLAY: "PlayMode",
    DISCUSSION: "Discussion",
    VOTING: "Voting",
    END: "EndOfMatch"
};

// Роли
const PlayerRoles = {
    CREWMATE: "Мирный",
    IMPOSTOR: "Предатель",
    SHERIFF: "Шериф"
};

// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ==========
const gameMode = {
    state: GameStates.WAITING,
    impostorId: null,
    sheriffId: null,
    deadPlayers: new Set(),
    reportedBodies: new Set(),
    meetingCalled: false,
    votes: new Map(),
    playerRoles: new Map(),
    bots: new Map(),
    adminId: "D411BD94CAE31F89",
    sabotageActive: false
};

// Контексты
const Inv = Inventory.GetContext();
const Sp = Spawns.GetContext();
const Dmg = Damage.GetContext();
const Props = Properties.GetContext();
const botsService = BotsService.GetContext();

// ========== ОСНОВНЫЕ ФУНКЦИИ ==========

// Инициализация сервера
function initServerProperties() {
    Props.Get('Time_State').Value = gameMode.state;
    Props.Get('Meeting_Active').Value = false;
    Props.Get('Votes_Total').Value = 0;
}

// Создание команд
function setupTeams() {
    Teams.Add('Players', 'Игроки', PLAYERS_COLOR);
    Teams.Add('Losers', 'Проигравшие', LOSERS_COLOR);

    const PlayersTeam = Teams.Get('Players');
    const LosersTeam = Teams.Get('Losers');

    PlayersTeam.Spawns.SpawnPointsGroups.Add(1);
    LosersTeam.Spawns.SpawnPointsGroups.Add(2);

    return { PlayersTeam, LosersTeam };
}

const { PlayersTeam, LosersTeam } = setupTeams();

// Управление состоянием игры
function setGameState(newState) {
    gameMode.state = newState;
    Props.Get('Time_State').Value = newState;
    
    const mainTimer = Timers.GetContext().Get("Main");
    
    switch(newState) {
        case GameStates.WAITING:
            Ui.GetContext().Hint.Value = "Ожидание игроков...";
            Sp.Enable = false;
            mainTimer.Restart(WAITING_TIME);
            break;
            
        case GameStates.PLAY:
            Ui.GetContext().Hint.Value = "Игра началась! Найдите предателя!";
            Sp.Enable = true;
            Sp.Spawn();
            assignRoles();
            startGameTimer();
            break;
            
        case GameStates.DISCUSSION:
            Ui.GetContext().Hint.Value = "Обсуждение! Готовьтесь к голосованию!";
            gameMode.meetingCalled = true;
            gameMode.votes.clear();
            Props.Get('Meeting_Active').Value = true;
            mainTimer.Restart(DISCUSSION_TIME);
            break;
            
        case GameStates.VOTING:
            Ui.GetContext().Hint.Value = "Голосование! Используйте /vote [ID]";
            Props.Get('Votes_Total').Value = 0;
            mainTimer.Restart(VOTING_TIME);
            break;
            
        case GameStates.END:
            Ui.GetContext().Hint.Value = "Игра окончена!";
            Sp.Enable = false;
            mainTimer.Restart(END_TIME);
            break;
    }
}

// Распределение ролей
function assignRoles() {
    const players = PlayersTeam.Players;
    if (players.length < 2) return;

    // Выбор предателя
    const impostorIndex = Math.floor(Math.random() * players.length);
    gameMode.impostorId = players[impostorIndex].id;
    gameMode.playerRoles.set(gameMode.impostorId, PlayerRoles.IMPOSTOR);
    Players.Get(gameMode.impostorId).Ui.Hint.Value = "ТЫ ПРЕДАТЕЛЬ! Убивай игроков, но будь осторожен!";

    // Выбор шерифа
    let sheriffIndex;
    do {
        sheriffIndex = Math.floor(Math.random() * players.length);
    } while (sheriffIndex === impostorIndex);
    
    gameMode.sheriffId = players[sheriffIndex].id;
    gameMode.playerRoles.set(gameMode.sheriffId, PlayerRoles.SHERIFF);
    Players.Get(gameMode.sheriffId).Ui.Hint.Value = "ТЫ ШЕРИФ! Ты можешь убивать, но только предателя!";
}

// Обработка убийств
function handleKill(killer, victim) {
    if (!killer || !victim) return;
    
    const killerRole = gameMode.playerRoles.get(killer.id);
    const victimRole = gameMode.playerRoles.get(victim.id);
    
    // Шериф стреляет в не предателя
    if (killerRole === PlayerRoles.SHERIFF && victimRole !== PlayerRoles.IMPOSTOR) {
        killPlayer(killer); // Шериф умирает
        return;
    }
    
    // Предатель убивает
    if (killerRole === PlayerRoles.IMPOSTOR) {
        killPlayer(victim);
        
        // Проверка условий победы
        const alivePlayers = PlayersTeam.Players.filter(p => 
            !gameMode.deadPlayers.has(p.id) && p.id !== gameMode.impostorId
        );
        
        if (alivePlayers.length <= 1) {
            endRound('impostor');
        }
    }
}

// Убийство игрока
function killPlayer(player) {
    // Перемещение в команду проигравших
    LosersTeam.Add(player);
    gameMode.deadPlayers.add(player.id);
    
    // Отключение оружия и возможностей
    player.inventory.Main.Value = false;
    player.inventory.Secondary.Value = false;
    player.inventory.Build.Value = false;
    
    // Создание "тела"
    gameMode.reportedBodies.add(player.id);
    
    // "Зависание" - телепортация в специальную зону
    player.SetPositionAndRotation(new Vector3(0, -100, 0), player.Rotation);
    player.Ui.Hint.Value = "Вы мертвы! Используйте /dead для общения";
}

// Система ботов
function createBot(player, skinId = 0, weaponId = 1) {
    const bot = botsService.CreateHuman({
        Position: player.Position,
        Rotation: player.Rotation,
        WeaponId: weaponId,
        SkinId: skinId
    });
    
    gameMode.bots.set(bot.Id, {
        ownerId: player.id,
        isPossessed: false
    });
    
    return bot;
}

function possessBot(player, botId) {
    const bot = botsService.Get(botId);
    if (!bot) return false;
    
    const botData = gameMode.bots.get(botId);
    if (botData.ownerId !== player.id) return false;
    
    botData.isPossessed = true;
    botData.lastPosition = player.Position.clone();
    
    // "Прячем" игрока
    player.SetPositionAndRotation(new Vector3(0, -200, 0), player.Rotation);
    
    // Таймер для синхронизации
    const syncTimer = Timers.GetContext().Get(`bot_sync_${botId}`);
    syncTimer.OnTimer.Add(() => {
        if (!botData.isPossessed) {
            syncTimer.Stop();
            return;
        }
        
        // Копируем позицию и поворот от игрока
        bot.SetPositionAndDirection(
            botData.lastPosition,
            player.Controls.LookDirection.Value
        );
    });
    
    syncTimer.RestartLoop(0.1);
    return true;
}

function unpossessBot(player, botId) {
    const bot = botsService.Get(botId);
    if (!bot) return false;
    
    const botData = gameMode.bots.get(botId);
    if (!botData.isPossessed || botData.ownerId !== player.id) return false;
    
    botData.isPossessed = false;
    player.SetPositionAndRotation(botData.lastPosition, player.Rotation);
    Timers.GetContext().Get(`bot_sync_${botId}`).Stop();
    return true;
}

// ========== КОМАНДЫ ЧАТА ==========
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
/sabotage - саботаж (предатель)
/vote [id] - голосовать за изгнание
/dead [msg] - чат для мертвых
/bot [skin] [weapon] - создать бота (предатель)
/aye [botId] - вселиться в бота (предатель)
/nay [botId] - выйти из бота (предатель)`;
        }
        
        else if (command === '/report') {
            if (args.length < 2) return;
            const bodyId = Number(args[1]);
            if (gameMode.reportedBodies.has(bodyId) && !gameMode.meetingCalled) {
                setGameState(GameStates.DISCUSSION);
            }
        }

        else if (command === '/meeting') {
            if (!gameMode.meetingCalled && gameMode.state === GameStates.PLAY) {
                setGameState(GameStates.DISCUSSION);
            }
        }
        
        else if (command === '/sabotage') {
            if (gameMode.playerRoles.get(sender.id) === PlayerRoles.IMPOSTOR &&
                gameMode.state === GameStates.PLAY) {
                    
                gameMode.sabotageActive = true;
                Ui.GetContext().Hint.Value = "САБОТАЖ! Системы отключены!";
                sender.Ui.Hint.Value = "Саботаж активирован!";
                
                // Отключаем свет на 30 секунд
                Timers.GetContext().Get("SabotageTimer").Restart(30, () => {
                    gameMode.sabotageActive = false;
                    Ui.GetContext().Hint.Value = "Системы восстановлены!";
                });
            }
        }
        
        else if (command === '/vote') {
            if (gameMode.state !== GameStates.VOTING) return;
            if (args.length < 2) return;
            
            const targetId = Number(args[1]);
            gameMode.votes.set(sender.id, targetId);
            
            const voteCount = [...gameMode.votes.values()]
                .filter(id => id === targetId)
                .length;
                
            sender.Ui.Hint.Value = `Ваш голос за ${targetId} учтен!`;
            Props.Get('Votes_Total').Value = gameMode.votes.size;
        }
        
        else if (command === '/dead') {
            const deadMessage = msg.substring(6).trim();
            Players.All.filter(p => gameMode.deadPlayers.has(p.id))
                .forEach(p => {
                    p.Ui.Hint.Value = `💀 ${sender.NickName}: ${deadMessage}`;
                });
        }
        
        else if (command === '/bot') {
            if (gameMode.playerRoles.get(sender.id) !== PlayerRoles.IMPOSTOR) return;
            
            const skinId = args[1] ? parseInt(args[1]) : 0;
            const weaponId = args[2] ? parseInt(args[2]) : 1;
            
            const bot = createBot(sender, skinId, weaponId);
            sender.Ui.Hint.Value = `Бот создан! ID: ${bot.Id}`;
        }
        
        else if (command === '/aye') {
            if (gameMode.playerRoles.get(sender.id) !== PlayerRoles.IMPOSTOR) return;
            
            const botId = args[1] ? parseInt(args[1]) : [...gameMode.bots.keys()][0];
            if (possessBot(sender, botId)) {
                sender.Ui.Hint.Value = "Вы вселились в бота!";
            } else {
                sender.Ui.Hint.Value = "Ошибка вселения!";
            }
        }
        
        else if (command === '/nay') {
            if (gameMode.playerRoles.get(sender.id) !== PlayerRoles.IMPOSTOR) return;
            
            const botId = args[1] ? parseInt(args[1]) : [...gameMode.bots.keys()][0];
            if (unpossessBot(sender, botId)) {
                sender.Ui.Hint.Value = "Вы вышли из бота!";
            } else {
                sender.Ui.Hint.Value = "Ошибка выхода!";
            }
        }
        
        // Админские команды
        else if (command === '/kick' && sender.id === gameMode.adminId) {
            // Реализация кика
        }
        // Другие админские команды...
    });
}

// ========== ЛИДЕРБОРД ==========
function setupLeaderboard() {
    LeaderBoard.PlayerLeaderBoardValues = [
        new DisplayValueHeader('IdInRoom', 'ID', 'ID'),
        new DisplayValueHeader('Status', 'Статус', 'Статус'),
        new DisplayValueHeader('Kills', 'Убийства', 'Убийства')
    ];

    LeaderBoard.PlayersWeightGetter.Set(function(p) {
        return p.Properties.Get('Kills').Value;
    });
}

// ========== ОБРАБОТКА ИГРОКА ==========
function initPlayer(player) {
    player.Properties.Get('Kills').Value = 0;
    player.Properties.Get('Deaths').Value = 0;
    
    // Все игроки получают оружие
    player.inventory.Main.Value = true;
    player.inventory.Secondary.Value = false;
    player.inventory.Melee.Value = true;
    player.inventory.Build.Value = false;
    
    // Начальная команда
    PlayersTeam.Add(player);
    
    if (gameMode.state === GameStates.PLAY) {
        player.Ui.Hint.Value = "Найдите предателя! Используйте /report для тел";
    }
}

// ========== ЗАВЕРШЕНИЕ РАУНДА ==========
function endRound(winner) {
    if (winner === 'impostor') {
        Ui.GetContext().Hint.Value = "Предатель побеждает!";
    } else {
        Ui.GetContext().Hint.Value = "Мирные побеждают!";
    }
    
    setGameState(GameStates.END);
}

// ========== ИНИЦИАЛИЗАЦИЯ ИГРЫ ==========
function initGameMode() {
    Dmg.DamageOut.Value = true;
    Dmg.FriendlyFire.Value = false;
    
    // Только предатель и шериф могут убивать
    Dmg.OnBeforeDamage.Add(function(damage) {
        const attacker = Players.Get(damage.AttackerPlayerId);
        if (!attacker) return;
        
        const role = gameMode.playerRoles.get(attacker.id);
        if (role !== PlayerRoles.IMPOSTOR && role !== PlayerRoles.SHERIFF) {
            damage.Cancel = true;
        }
    });
    
    initServerProperties();
    setupTeams();
    setupLeaderboard();
    initChatCommands();
    setupEventHandlers();
    setGameState(GameStates.WAITING);
}

// ========== ОСНОВНЫЕ ОБРАБОТЧИКИ ==========
function setupEventHandlers() {
    Players.OnPlayerConnected.Add(function(player) {
        initPlayer(player);
        player.Ui.Hint.Value = 'Добро пожаловать в "Предательство"!';
        
        if (Players.All.length >= 2 && gameMode.state === GameStates.WAITING) {
            setGameState(GameStates.PLAY);
        }
    });
    
    Damage.OnKill.Add(handleKill);
    
    Damage.OnDeath.Add(function(player) {
        player.Properties.Deaths.Value++;
    });
    
    // Таймер игры
    Timers.GetContext().Get("GameTimer").OnTimer.Add(function(t) {
        if (gameMode.state === GameStates.PLAY) {
            const alivePlayers = PlayersTeam.Players.filter(p => 
                !gameMode.deadPlayers.has(p.id)
            );
            
            // Проверка условий победы
            if (alivePlayers.length <= 1 && gameMode.impostorId) {
                const impostor = Players.Get(gameMode.impostorId);
                if (impostor && impostor.Team.Name === 'Players') {
                    endRound('impostor');
                }
            }
        }
    });
}

// ЗАПУСК ИГРЫ
initGameMode();
