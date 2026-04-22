import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } from '@discordjs/voice';
import play from 'play-dl';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize bot with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

// Store active connections to prevent multiple players
const connections = new Map();

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  
  // Register slash command
  const commands = [
    new SlashCommandBuilder()
      .setName('music')
      .setDescription('Play music from YouTube or SoundCloud')
      .addStringOption(option =>
        option.setName('link')
          .setDescription('YouTube or SoundCloud link')
          .setRequired(true))
  ];
  
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash command registered');
  } catch (error) {
    console.error('❌ Failed to register command:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'music') return;
  
  const link = interaction.options.getString('link');
  
  // Defer reply to avoid timeout
  await interaction.deferReply();
  
  // Check if user is in voice channel
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.editReply('❌ You need to be in a voice channel first!');
  }
  
  try {
    // Validate link
    const isValid = await play.validate(link);
    if (!isValid) {
      return interaction.editReply('❌ Invalid link. Please provide a YouTube or SoundCloud URL.');
    }
    
    // Check if it's YouTube or SoundCloud
    const isYouTube = await play.yt_validate(link);
    const isSoundCloud = await play.so_validate(link);
    
    let streamUrl, title;
    
    if (isYouTube) {
      const video = await play.video_info(link);
      title = video.video_details.title;
      streamUrl = link;
    } else if (isSoundCloud) {
      const track = await play.soundcloud(link);
      title = track.name;
      streamUrl = link;
    } else {
      return interaction.editReply('❌ Only YouTube and SoundCloud links are supported.');
    }
    
    // Send "now playing" message
    await interaction.editReply(`🎵 Now playing: **${title}**`);
    
    // Get audio stream
    let stream;
    try {
      stream = await play.stream(streamUrl, {
        quality: 2, // High quality
        discordPlayerCompatibility: true
      });
    } catch (streamError) {
      console.error('Stream error:', streamError);
      return interaction.followUp('❌ Failed to get audio stream. The video might be age-restricted or unavailable.');
    }
    
    // Create audio resource
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true
    });
    
    // Set volume (optional)
    resource.volume.setVolume(0.8);
    
    // Join voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator
    });
    
    // Create audio player
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    
    player.play(resource);
    connection.subscribe(player);
    
    // Store connection to clean up later
    const guildId = interaction.guildId;
    if (connections.has(guildId)) {
      const oldConnection = connections.get(guildId);
      if (oldConnection) oldConnection.destroy();
    }
    connections.set(guildId, connection);
    
    // Handle player events
    player.on(AudioPlayerStatus.Idle, () => {
      if (connections.has(guildId)) {
        const conn = connections.get(guildId);
        if (conn) conn.destroy();
        connections.delete(guildId);
      }
    });
    
    player.on('error', (error) => {
      console.error('Player error:', error);
      interaction.followUp('❌ Playback error occurred.');
      if (connections.has(guildId)) {
        connections.get(guildId).destroy();
        connections.delete(guildId);
      }
    });
    
    connection.on('error', (error) => {
      console.error('Connection error:', error);
      interaction.followUp('❌ Voice connection error.');
      connections.delete(guildId);
    });
    
  } catch (error) {
    console.error('Music command error:', error);
    
    // Handle specific errors
    if (error.message.includes('AGE_RESTRICTED')) {
      return interaction.editReply('❌ This video is age-restricted and cannot be played.');
    }
    
    if (error.message.includes('premium')) {
      return interaction.editReply('❌ SoundCloud tracks may require a premium account to play.');
    }
    
    return interaction.editReply('❌ Failed to play music. Please check the link and try again.');
  }
});

// Clean up on bot disconnect
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member.id === client.user.id && !newState.channelId) {
    const guildId = oldState.guild.id;
    if (connections.has(guildId)) {
      connections.get(guildId).destroy();
      connections.delete(guildId);
    }
  }
});

// Login
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

client.login(token);
