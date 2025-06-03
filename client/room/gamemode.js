import { DisplayValueHeader, Color, Vector3 } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, Teams, Damage, Ui, Properties, GameMode, Spawns, Timers, Chat, Bots } from 'pixel_combats/room';

// ========== КОНСТАНТЫ И НАСТРОЙКИ ==========
const WAITING_TIME = 10;      // Ожидание игроков (сек)
const PLAY_TIME = 300;        // Время игры (сек)
const END_TIME = 30;          // Время окончания (сек)

// Цвета команд
const PLAYERS_COLOR = new Color(0, 0.5, 1, 0);     // Синий
const LOSERS_COLOR = new Color(0.3, 0.3, 0.3, 0);  // Серый

// Состояния игры
const GameStates = {
    WAITING: "WaitingPlayers",
    PLAY: "PlayMode",
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
    playerRoles: new Map(),
    bots: new Map(),
    adminId: "D411BD94CAE31F89",
    gameTimer: null
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
    Props.Get('Game_State').Value = gameMode.state;
    Props.Get('Time_Left').Value = PLAY_TIME;
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
    Props.Get('Game_State').Value = newState;
    
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
    Players.Get(gameMode.impostorId).Ui.Hint.Value = "ТЫ ПРЕДАТЕЛЬ! Убивай игроков! Команды: /bot, /aye, /nay";

    // Выбор шерифа (если игроков достаточно)
    if (players.length >= 3) {
        let sheriffIndex;
        do {
            sheriffIndex = Math.floor(Math.random() * players.length);
        } while (sheriffIndex === impostorIndex);
        
        gameMode.sheriffId = players[sheriffIndex].id;
        gameMode.playerRoles.set(gameMode.sheriffId, PlayerRoles.SHERIFF);
        Players.Get(gameMode.sheriffId).Ui.Hint.Value = "ТЫ ШЕРИФ! Ты можешь убивать предателя!";
    }
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
        checkWinConditions();
    }
}

// Убийство игрока
function killPlayer(player) {
    // Перемещение в команду проигравших
    LosersTeam.Add(player);
    gameMode.deadPlayers.add(player.id);
    
    // Отключение оружия
    player.inventory.Main.Value = false;
    player.inventory.Secondary.Value = false;
    
    // Телепортация в специальную зону
    player.SetPositionAndRotation(new Vector3(0, -100, 0), player.Rotation);
    player.Ui.Hint.Value = "Вы мертвы!";
}

// Проверка условий победы
function checkWinConditions() {
    const alivePlayers = PlayersTeam.Players.filter(p => 
        !gameMode.deadPlayers.has(p.id)
    );
    
    // Если предатель убит
    if (!alivePlayers.find(p => p.id === gameMode.impostorId)) {
        endRound('crewmates');
        return;
    }
    
    // Если остался только предатель и 1 мирный
    if (alivePlayers.length <= 2) {
        endRound('impostor');
        return;
    }
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

        const args = msg.split(' ');
        const command = args[0].toLowerCase();

        if (command === '/help') {
            sender.Ui.Hint.Value = `Доступные команды:
/bot [skin] [weapon] - создать бота (предатель)
/aye [botId] - вселиться в бота (предатель)
/nay [botId] - выйти из бота (предатель)
/vote [id] - проголосовать за изгнание`;
        }
        
        else if (command === '/bot') {
            if (gameMode.playerRoles.get(sender.id) !== PlayerRoles.IMPOSTOR) {
                sender.Ui.Hint.Value = "❌ Только для предателя!";
                return;
            }
            
            const skinId = args[1] ? parseInt(args[1]) : 0;
            const weaponId = args[2] ? parseInt(args[2]) : 1;
            
            const bot = createBot(sender, skinId, weaponId);
            sender.Ui.Hint.Value = `🤖 Бот создан! ID: ${bot.Id}`;
        }
        
        else if (command === '/aye') {
            if (gameMode.playerRoles.get(sender.id) !== PlayerRoles.IMPOSTOR) {
                sender.Ui.Hint.Value = "❌ Только для предателя!";
                return;
            }
            
            const botId = args[1] ? parseInt(args[1]) : [...gameMode.bots.keys()][0];
            if (possessBot(sender, botId)) {
                sender.Ui.Hint.Value = "👻 Вы вселились в бота!";
            } else {
                sender.Ui.Hint.Value = "❌ Ошибка вселения!";
            }
        }
        
        else if (command === '/nay') {
            if (gameMode.playerRoles.get(sender.id) !== PlayerRoles.IMPOSTOR) {
                sender.Ui.Hint.Value = "❌ Только для предателя!";
                return;
            }
            
            const botId = args[1] ? parseInt(args[1]) : [...gameMode.bots.keys()][0];
            if (unpossessBot(sender, botId)) {
                sender.Ui.Hint.Value = "👤 Вы вышли из бота!";
            } else {
                sender.Ui.Hint.Value = "❌ Ошибка выхода!";
            }
        }
        
        else if (command === '/vote') {
            if (args.length < 2) return;
            
            const targetId = Number(args[1]);
            const target = Players.Get(targetId);
            if (!target) return;
            
            // Простое голосование - сразу убиваем
            killPlayer(target);
            sender.Ui.Hint.Value = `✅ Вы проголосовали против ${target.NickName}`;
            checkWinConditions();
        }
    });
}

// ========== ЛИДЕРБОРД ==========
function setupLeaderboard() {
    LeaderBoard.PlayerLeaderBoardValues = [
        new DisplayValueHeader('IdInRoom', 'ID', 'ID'),
        new DisplayValueHeader('Role', 'Роль', 'Роль'),
        new DisplayValueHeader('Status', 'Статус', 'Статус')
    ];

    LeaderBoard.PlayersWeightGetter.Set(function(p) {
        return p.id; // Сортируем по ID
    });
}

// ========== ОБРАБОТКА ИГРОКА ==========
function initPlayer(player) {
    // Все игроки получают оружие
    player.inventory.Main.Value = true;
    player.inventory.Melee.Value = true;
    
    // Начальная команда
    PlayersTeam.Add(player);
    
    if (gameMode.state === GameStates.PLAY) {
        player.Ui.Hint.Value = "Найдите предателя!";
    }
}

// Таймер игры
function startGameTimer() {
    gameMode.gameTimer = Timers.GetContext().Get("GameTimer");
    let timeLeft = PLAY_TIME;
    
    gameMode.gameTimer.OnTimer.Add(() => {
        timeLeft--;
        Props.Get('Time_Left').Value = timeLeft;
        
        if (timeLeft <= 0) {
            endRound('impostor');
            return;
        }
        
        gameMode.gameTimer.RestartLoop(1);
    });
    
    gameMode.gameTimer.RestartLoop(1);
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
    // При подключении игрока
    Players.OnPlayerConnected.Add(function(player) {
        initPlayer(player);
        player.Ui.Hint.Value = 'Добро пожаловать в "Предательство"! Напишите /help';
        
        if (Players.All.length >= 2 && gameMode.state === GameStates.WAITING) {
            setGameState(GameStates.PLAY);
        }
    });
    
    // При смене команды
    Teams.OnPlayerChangeTeam.Add(function(player) {
        initPlayer(player);
    });
    
    // При убийстве
    Damage.OnKill.Add(handleKill);
    
    // При смерти
    Damage.OnDeath.Add(function(player) {
        player.Properties.Deaths.Value++;
    });
    
    // Основной таймер
    Timers.GetContext().Get("Main").OnTimer.Add(function() {
        switch(gameMode.state) {
            case GameStates.WAITING:
                if (Players.All.length >= 2) {
                    setGameState(GameStates.PLAY);
                }
                break;
                
            case GameStates.END:
                // Перезапуск игры
                gameMode.impostorId = null;
                gameMode.sheriffId = null;
                gameMode.deadPlayers.clear();
                gameMode.playerRoles.clear();
                gameMode.bots.clear();
                
                // Переместить всех игроков в основную команду
                Players.All.forEach(p => PlayersTeam.Add(p));
                setGameState(GameStates.WAITING);
                break;
        }
    });
}

// ЗАПУСК ИГРЫ
initGameMode();
