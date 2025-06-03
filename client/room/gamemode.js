import { DisplayValueHeader, Color, Vector3 } from 'pixel_combats/basic';
import { Game, Players, Inventory, LeaderBoard, BuildBlocksSet, Teams, Damage, BreackGraph, Ui, Properties, GameMode, Spawns, Timers, Bots } from 'pixel_combats/room';

// Настройки режима
const WAITING_TIME = 10; // Ожидание игроков
const DISCUSSION_TIME = 45; // Время на обсуждение
const VOTING_TIME = 30; // Время на голосование
const GAME_TIME = 600;   // Основное время игры
const END_TIME = 30;     // Время окончания матча

// Цвета команд
const playersColor = new Color(0, 0, 1, 0); // Синий - Игроки
const losersColor = new Color(0.5, 0.5, 0.5, 0); // Серый - Проигравшие

// Контексты
const Inv = Inventory.GetContext();
const Sp = Spawns.GetContext();
const Dmg = Damage.GetContext();
const Props = Properties.GetContext();

// Состояния игры
const GameStates = {
    WAITING: "WaitingPlayers",
    GAME: "GameMode",
    DISCUSSION: "Discussion",
    VOTING: "Voting",
    END: "EndOfMatch"
};

// Основные таймеры
const mainTimer = Timers.GetContext().Get("Main");
const serverTimer = Timers.GetContext().Get("Server");
const roundTimer = Timers.GetContext().Get("Round");

// Глобальные переменные
const gameMode = {
    state: GameStates.WAITING,
    traitor: null,
    sheriff: null,
    deadPlayers: new Set(),
    bodies: new Map(),
    bodiesReported: new Set(),
    emergencyMeetings: 0,
    maxEmergencyMeetings: 2,
    votes: new Map(),
    playerBots: new Map(),
    playerInBot: new Map(),
    botPlayer: new Map(),
    freezeTimers: new Map(),
    adminId: "D411BD94CAE31F89"
};

// Инициализация сервера
function initServerProperties() {
    Props.Get('Time_Hours').Value = 0;
    Props.Get('Time_Minutes').Value = 0;
    Props.Get('Time_Seconds').Value = 0;
    Props.Get('Players_Now').Value = 0;
    Props.Get('Players_WereMax').Value = 24;
    Props.Get('Time_FixedString').Value = '00:00:00';
    Props.Get('Round_Time').Value = GAME_TIME;
    Props.Get('Game_State').Value = gameMode.state;
    Props.Get('Emergency_Meetings').Value = gameMode.maxEmergencyMeetings;
}

function initServerTimer() {
    serverTimer.OnTimer.Add(function(t) {
        Props.Get('Time_Seconds').Value++;
        
        if (Props.Get('Time_Seconds').Value >= 60) {
            Props.Get('Time_Seconds').Value = 0;
            Props.Get('Time_Minutes').Value++;
        }
        
        if (Props.Get('Time_Minutes').Value >= 60) {
            Props.Get('Time_Minutes').Value = 0;
            Props.Get('Time_Hours').Value++;
        }
        
        Props.Get('Players_Now').Value = Players.All.length;
        
        if (Props.Get('Players_Now').Value > Props.Get('Players_WereMax').Value) {
            Props.Get('Players_WereMax').Value = Props.Get('Players_Now').Value;
        }
        
        Props.Get('Time_FixedString').Value = 
            `${Props.Get('Time_Hours').Value.toString().padStart(2, '0')}:` +
            `${Props.Get('Time_Minutes').Value.toString().padStart(2, '0')}:` +
            `${Props.Get('Time_Seconds').Value.toString().padStart(2, '0')}`;
        
        serverTimer.RestartLoop(1);
    });
    serverTimer.RestartLoop(1);
}

// Создание команд
function setupTeams() {
    Teams.Add('Players', 'Игроки', playersColor);
    Teams.Add('Losers', 'Проигравшие', losersColor);

    const PlayersTeam = Teams.Get('Players');
    const LosersTeam = Teams.Get('Losers');

    // Настройки спавнов
    PlayersTeam.Spawns.SpawnPointsGroups.Add(1);
    LosersTeam.Spawns.SpawnPointsGroups.Add(2);

    return { PlayersTeam, LosersTeam };
}

const { PlayersTeam, LosersTeam } = setupTeams();

// Управление состоянием игры
function setGameState(newState) {
    gameMode.state = newState;
    Props.Get('Game_State').Value = newState;
    
    switch(newState) {
        case GameStates.WAITING:
            Ui.GetContext().Hint.Value = "Ожидание игроков...";
            Sp.Enable = false;
            mainTimer.Restart(WAITING_TIME);
            break;
            
        case GameStates.GAME:
            Ui.GetContext().Hint.Value = "Среди вас есть предатель! Будьте осторожны!";
            Inv.Main.Value = true; // Оружие у всех
            Inv.Secondary.Value = false;
            Inv.Melee.Value = true;
            Inv.Build.Value = false;
            Dmg.DamageOut.Value = false; // Урон только у предателя и шерифа
            Sp.Enable = true;
            Sp.Spawn();
            assignRoles();
            mainTimer.Restart(GAME_TIME);
            break;
            
        case GameStates.DISCUSSION:
            Ui.GetContext().Hint.Value = "Обсуждение! Говорите и выдвигайте теории!";
            freezeAllPlayers();
            mainTimer.Restart(DISCUSSION_TIME);
            break;
            
        case GameStates.VOTING:
            Ui.GetContext().Hint.Value = "Голосование! Используйте /vote [id]";
            gameMode.votes.clear();
            mainTimer.Restart(VOTING_TIME);
            break;
            
        case GameStates.END:
            Ui.GetContext().Hint.Value = "Матч окончен!";
            Sp.Enable = false;
            mainTimer.Restart(END_TIME);
            Game.RestartGame();
            break;
    }
}

// Заморозка игроков во время обсуждения
function freezeAllPlayers() {
    Players.All.forEach(player => {
        const freezeTimer = Timers.GetContext(player).Get('FreezeTimer');
        freezeTimer.OnTimer.Add(() => {
            player.SetPositionAndRotation(player.Position, player.Rotation);
        });
        freezeTimer.RestartLoop(0.1);
        gameMode.freezeTimers.set(player.id, freezeTimer);
    });
}

// Разморозка игроков
function unfreezeAllPlayers() {
    Players.All.forEach(player => {
        const freezeTimer = gameMode.freezeTimers.get(player.id);
        if (freezeTimer) {
            freezeTimer.Stop();
            gameMode.freezeTimers.delete(player.id);
        }
    });
}

// Назначение ролей
function assignRoles() {
    const players = Players.All;
    if (players.length < 3) return;
    
    // Выбираем предателя
    const traitorIndex = Math.floor(Math.random() * players.length);
    gameMode.traitor = players[traitorIndex].id;
    players[traitorIndex].Ui.Hint.Value = "ТЫ ПРЕДАТЕЛЬ! Убей всех, но не попадись!";
    players[traitorIndex].contextedProperties.SkinType.Value = 1;
    
    // Выбираем шерифа (если достаточно игроков)
    if (players.length >= 5) {
        let sheriffIndex;
        do {
            sheriffIndex = Math.floor(Math.random() * players.length);
        } while (sheriffIndex === traitorIndex);
        
        gameMode.sheriff = players[sheriffIndex].id;
        players[sheriffIndex].Ui.Hint.Value = "ТЫ ШЕРИФ! Найди и убей предателя!";
        players[sheriffIndex].contextedProperties.SkinType.Value = 3;
    }
    
    // Остальные - обычные игроки
    players.forEach((player, index) => {
        if (index !== traitorIndex && index !== gameMode.sheriff) {
            player.Ui.Hint.Value = "Вы обычный игрок! Ищи предателя!";
            player.contextedProperties.SkinType.Value = 0;
        }
    });
}

// Проверка условий победы
function checkWinConditions() {
    const alivePlayers = Players.All.filter(p => !gameMode.deadPlayers.has(p.id));
    const traitorAlive = alivePlayers.some(p => p.id === gameMode.traitor);
    const sheriffAlive = gameMode.sheriff ? alivePlayers.some(p => p.id === gameMode.sheriff) : false;
    
    // Предатель побеждает, если остался 1 игрок и он сам
    if (alivePlayers.length === 1 && traitorAlive) {
        endRound('Предатель');
        return;
    }
    
    // Игроки побеждают, если предатель убит
    if (!traitorAlive) {
        endRound('Игроки');
        return;
    }
    
    // Предатель побеждает, если время вышло
    if (Props.Get('Round_Time').Value <= 0) {
        endRound('Предатель');
        return;
    }
}

// Окончание раунда
function endRound(winner) {
    let message = "";
    
    if (winner === 'Предатель') {
        message = "Предатель побеждает!";
        const traitor = Players.Get(gameMode.traitor);
        if (traitor) traitor.Properties.Scores.Value += 10000;
    } else {
        message = "Игроки побеждают!";
        Players.All.forEach(player => {
            if (!gameMode.deadPlayers.has(player.id)) {
                player.Properties.Scores.Value += 5000;
            }
        });
    }
    
    room.Ui.Hint.Value = message;
    setGameState(GameStates.END);
}

// Система убийств
function handleKill(killer, victim) {
    if (!killer || !victim) return;
    
    // Проверяем, может ли убийца наносить урон
    const isTraitor = killer.id === gameMode.traitor;
    const isSheriff = killer.id === gameMode.sheriff;
    
    if (!isTraitor && !isSheriff) {
        killer.Ui.Hint.Value = "Вы не можете атаковать других игроков!";
        return;
    }
    
    // Шериф может убивать только предателя
    if (isSheriff && victim.id !== gameMode.traitor) {
        killer.Ui.Hint.Value = "Ошибка! Вы убили невиновного!";
        killPlayer(killer);
        return;
    }
    
    // Предатель или шериф (убивающий предателя) убивает
    killPlayer(victim);
    
    // Создаем тело для репорта
    gameMode.bodies.set(victim.id, {
        position: victim.Position,
        time: Date.now()
    });
    
    // Проверяем условия победы
    checkWinConditions();
}

// Убийство игрока
function killPlayer(player) {
    player.Team = LosersTeam;
    gameMode.deadPlayers.add(player.id);
    player.contextedProperties.SkinType.Value = 2;
    player.Ui.Hint.Value = "Вы мертвы! Используйте /dead [сообщение] для чата";
    
    // Запускаем цикл зависания для жертвы
    const freezeTimer = Timers.GetContext(player).Get('DeathFreeze');
    freezeTimer.OnTimer.Add(() => {
        player.SetPositionAndRotation(player.Position, player.Rotation);
    });
    freezeTimer.RestartLoop(0.1);
    gameMode.freezeTimers.set(player.id, freezeTimer);
}

// Система отчетов о телах
function reportBody(reporter, bodyId) {
    if (gameMode.bodiesReported.has(bodyId)) return;
    
    gameMode.bodiesReported.add(bodyId);
    room.Ui.Hint.Value = `${reporter.NickName} сообщил о теле! Начинается обсуждение!`;
    setGameState(GameStates.DISCUSSION);
}

// Система экстренных собраний
function callEmergencyMeeting(caller) {
    if (gameMode.meetingCalled || gameMode.emergencyMeetings >= gameMode.maxEmergencyMeetings) {
        caller.Ui.Hint.Value = "Собрание уже идет или лимит исчерпан!";
        return;
    }
    
    gameMode.emergencyMeetings++;
    gameMode.meetingCalled = true;
    Props.Get('Emergency_Meetings').Value = gameMode.maxEmergencyMeetings - gameMode.emergencyMeetings;
    room.Ui.Hint.Value = `${caller.NickName} созывает экстренное собрание!`;
    setGameState(GameStates.DISCUSSION);
}

// Система голосования
function vote(voter, suspectId) {
    if (gameMode.state !== GameStates.VOTING) {
        voter.Ui.Hint.Value = "Сейчас не время голосования!";
        return;
    }
    
    if (gameMode.deadPlayers.has(voter.id)) {
        voter.Ui.Hint.Value = "Мертвые не могут голосовать!";
        return;
    }
    
    const suspect = Players.Get(suspectId);
    if (!suspect) {
        voter.Ui.Hint.Value = "Игрок не найден!";
        return;
    }
    
    gameMode.votes.set(voter.id, suspectId);
    voter.Ui.Hint.Value = `Ваш голос за ${suspect.NickName} учтен!`;
    
    // Проверяем, проголосовали ли все живые
    const alivePlayers = Players.All.filter(p => !gameMode.deadPlayers.has(p.id));
    if (gameMode.votes.size >= alivePlayers.length) {
        finishVoting();
    }
}

// Завершение голосования
function finishVoting() {
    // Подсчет голосов
    const voteCounts = new Map();
    gameMode.votes.forEach(suspectId => {
        voteCounts.set(suspectId, (voteCounts.get(suspectId) || 0) + 1);
    });
    
    // Находим игрока с наибольшим количеством голосов
    let maxVotes = 0;
    let ejectedPlayerId = null;
    
    voteCounts.forEach((votes, playerId) => {
        if (votes > maxVotes) {
            maxVotes = votes;
            ejectedPlayerId = playerId;
        }
    });
    
    if (ejectedPlayerId && maxVotes > 0) {
        const ejectedPlayer = Players.Get(ejectedPlayerId);
        ejectedPlayer.Ui.Hint.Value = "Вас изгнали!";
        killPlayer(ejectedPlayer);
        
        if (ejectedPlayerId === gameMode.traitor) {
            room.Ui.Hint.Value = `${ejectedPlayer.NickName} был предателем! Игроки побеждают!`;
            endRound('Игроки');
        } else {
            room.Ui.Hint.Value = `${ejectedPlayer.NickName} был невиновен!`;
            checkWinConditions();
        }
    } else {
        room.Ui.Hint.Value = "Никто не был изгнан!";
    }
    
    // Возвращаемся к игре
    gameMode.meetingCalled = false;
    unfreezeAllPlayers();
    setGameState(GameStates.GAME);
}

// Система ботов для предателя
function spawnBot(player, skinId, weaponId) {
    if (player.id !== gameMode.traitor) {
        player.Ui.Hint.Value = "Только предатель может создавать ботов!";
        return;
    }
    
    if (gameMode.playerBots.has(player.id)) {
        player.Ui.Hint.Value = "Вы уже создали бота!";
        return;
    }
    
    const botData = new Bots.HumanBotSpawnData();
    botData.Position = player.Position;
    botData.Rotation = player.Rotation;
    botData.SkinId = skinId;
    botData.WeaponId = weaponId;
    
    const bot = Bots.CreateHuman(botData);
    if (!bot) return;
    
    gameMode.playerBots.set(player.id, bot);
    player.Ui.Hint.Value = "Бот создан! Используйте /aye для управления им";
}

// Вселение в бота
function possessBot(player) {
    if (player.id !== gameMode.traitor) {
        player.Ui.Hint.Value = "Только предатель может управлять ботами!";
        return;
    }
    
    const bot = gameMode.playerBots.get(player.id);
    if (!bot) {
        player.Ui.Hint.Value = "Сначала создайте бота!";
        return;
    }
    
    if (gameMode.playerInBot.has(player.id)) {
        player.Ui.Hint.Value = "Вы уже управляете ботом!";
        return;
    }
    
    // Сохраняем текущую позицию игрока
    const originalPosition = player.Position;
    const originalRotation = player.Rotation;
    
    // Телепортируем игрока под карту
    player.SetPositionAndRotation(new Vector3(0, -1000, 0), player.Rotation);
    
    // Настраиваем управление ботом
    const controlTimer = Timers.GetContext(player).Get('BotControl');
    controlTimer.OnTimer.Add(() => {
        if (bot.Alive) {
            bot.SetPositionAndDirection(player.Position, player.LookDirection);
        }
    });
    controlTimer.RestartLoop(0.1);
    
    gameMode.playerInBot.set(player.id, bot);
    gameMode.botPlayer.set(bot.Id, player.id);
    
    player.Ui.Hint.Value = "Вы управляете ботом!";
}

// Вспомогательные функции
function freezeAllPlayers() {
    Players.All.forEach(player => {
        const freezeTimer = Timers.GetContext(player).Get('FreezeTimer');
        freezeTimer.OnTimer.Add(() => {
            player.SetPositionAndRotation(player.Position, player.Rotation);
        });
        freezeTimer.RestartLoop(0.1);
        gameMode.freezeTimers.set(player.id, freezeTimer);
    });
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
/vote [id] - голосовать за изгнание
/bot [skin] [weapon] - создать бота (предатель)
/aye - управлять ботом (предатель)
/dead [msg] - чат для мертвых`;
        }
        
        else if (command === '/report') {
            if (args.length < 2) return;
            const bodyId = Number(args[1]);
            reportBody(sender, bodyId);
        }

        else if (command === '/meeting') {
            callEmergencyMeeting(sender);
        }

        else if (command === '/vote') {
            if (args.length < 2) return;
            const suspectId = Number(args[1]);
            vote(sender, suspectId);
        }
        
        else if (command === '/bot') {
            if (args.length < 3) {
                sender.Ui.Hint.Value = "Использование: /bot [skin] [weapon]";
                return;
            }
            const skinId = parseInt(args[1]);
            const weaponId = parseInt(args[2]);
            spawnBot(sender, skinId, weaponId);
        }
        
        else if (command === '/aye') {
            possessBot(sender);
        }
        
        else if (command === '/dead') {
            const message = msg.substring(6).trim();
            if (message) {
                // Отправляем сообщение в мертвый чат
                Players.All.forEach(player => {
                    if (gameMode.deadPlayers.has(player.id)) {
                        player.Ui.Hint.Value = `[МЕРТВЫЕ] ${sender.NickName}: ${message}`;
                    }
                });
            }
        }
    });
}

// Настройка лидерборда
function setupLeaderboard() {
    LeaderBoard.PlayerLeaderBoardValues = [
        new DisplayValueHeader('Kills', 'Убийства', 'Убийства'),
        new DisplayValueHeader('Deaths', 'Смерти', 'Смерти'),
        new DisplayValueHeader('Scores', 'Очки', 'Очки')
    ];

    LeaderBoard.PlayersWeightGetter.Set(function(p) {
        return p.Properties.Get('Scores').Value;
    });
}

// Обработчики событий
function setupEventHandlers() {
    Players.OnPlayerConnected.Add(function(player) {
        // Новые игроки присоединяются как мертвые, если игра уже идет
        if (gameMode.state !== GameStates.WAITING && gameMode.state !== GameStates.END) {
            player.Team = LosersTeam;
            gameMode.deadPlayers.add(player.id);
            player.contextedProperties.SkinType.Value = 2;
            player.Ui.Hint.Value = "Вы присоединились к уже идущей игре как мертвый";
            killPlayer(player);
            return;
        }
        
        player.Team = PlayersTeam;
        player.Properties.Get('Kills').Value = 0;
        player.Properties.Get('Deaths').Value = 0;
        player.Properties.Get('Scores').Value = 0;
        player.contextedProperties.SkinType.Value = 0;
        
        if (Players.All.length >= 3 && gameMode.state === GameStates.WAITING) {
            setGameState(GameStates.GAME);
        }
    });
    
    Teams.OnPlayerChangeTeam.Add(function(player) {
        // Запрещаем смену команды кроме как через убийство
        if (player.Team.Name !== 'Losers') {
            player.Team = PlayersTeam;
        }
    });
    
    Damage.OnKill.Add(function(killer, victim) {
        handleKill(killer, victim);
    });
    
    Damage.OnDeath.Add(function(player) {
        player.Properties.Deaths.Value++;
    });
    
    // Обработчик основного таймера
    mainTimer.OnTimer.Add(function() {
        switch(gameMode.state) {
            case GameStates.WAITING:
                if (Players.All.length >= 3) {
                    setGameState(GameStates.GAME);
                } else {
                    mainTimer.Restart(WAITING_TIME);
                }
                break;
                
            case GameStates.GAME:
                Props.Get('Round_Time').Value--;
                if (Props.Get('Round_Time').Value <= 0) {
                    checkWinConditions();
                } else {
                    mainTimer.Restart(1);
                }
                break;
                
            case GameStates.DISCUSSION:
                setGameState(GameStates.VOTING);
                break;
                
            case GameStates.VOTING:
                finishVoting();
                break;
                
            case GameStates.END:
                Game.RestartGame();
                break;
        }
    });
}

// Инициализация игры
function initGameMode() {
    Dmg.DamageOut.Value = true;
    Dmg.FriendlyFire.Value = false;
    BreackGraph.OnlyPlayerBlocksDmg = true;
    
    initServerProperties();
    initServerTimer();
    setupLeaderboard();
    
    setupEventHandlers();
    setGameState(GameStates.WAITING);
}

// Запуск игры
initGameMode();
