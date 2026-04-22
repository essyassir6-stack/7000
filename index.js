import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus } from '@discordjs/voice';
import ytdl from 'ytdl-core';
import { SoundCloud } from 'soundcloud.ts';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Store active connections
const activePlayers = new Map();

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log(`✅ FFmpeg path: ${ffmpeg}`);
  
  // Register slash command
  const commands = [
    new SlashCommandBuilder()
      .setName('music')
      .setDescription('Play music from YouTube or SoundCloud')
      .addStringOption(option =>
        option.setName('link')
          .setDescription('YouTube or SoundCloud URL')
          .setRequired(true))
  ];
  
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash command registered');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'music') return;
  
  const link = interaction.options.getString('link');
  
  // Always defer reply to prevent timeout
  await interaction.deferReply();
  
  // Check voice channel
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.editReply('❌ Please join a voice channel first!');
  }
  
  // Check bot permissions
  const botMember = interaction.guild.members.me;
  if (!voiceChannel.permissionsFor(botMember).has('Connect')) {
    return interaction.editReply('❌ I don\'t have permission to join that voice channel!');
  }
  
  if (!voiceChannel.permissionsFor(botMember).has('Speak')) {
    return interaction.editReply('❌ I don\'t have permission to speak in that voice channel!');
  }
  
  try {
    let audioStream;
    let title = 'Unknown Title';
    let source = 'unknown';
    
    // Check if it's a YouTube link
    if (ytdl.validateURL(link)) {
      source = 'youtube';
      try {
        const info = await ytdl.getInfo(link);
        title = info.videoDetails.title;
        
        // Check for age restriction
        if (info.videoDetails.age_restricted) {
          return interaction.editReply('❌ This video is age-restricted and cannot be played.');
        }
        
        // Create audio stream with proper options
        audioStream = ytdl(link, {
          quality: 'highestaudio',
          filter: 'audioonly',
          highWaterMark: 1 << 25
        });
        
      } catch (ytError) {
        console.error('YouTube error:', ytError);
        if (ytError.message.includes('age restricted')) {
          return interaction.editReply('❌ Age-restricted videos cannot be played.');
        }
        return interaction.editReply('❌ Failed to process YouTube video. It might be private or unavailable.');
      }
      
    } else {
      // Try SoundCloud
      try {
        const soundcloud = new SoundCloud();
        // Check if it's a valid SoundCloud track
        const trackUrlPattern = /soundcloud\.com\/([^\/]+\/[^\/]+)/;
        if (!trackUrlPattern.test(link)) {
          return interaction.editReply('❌ Unsupported link. Please provide a YouTube or SoundCloud URL.\n\nSupported formats:\n• YouTube: https://youtube.com/watch?v=...\n• SoundCloud: https://soundcloud.com/user/track');
        }
        
        source = 'soundcloud';
        // For SoundCloud, we need to resolve the track
        const trackId = link.split('/').pop();
        // Note: SoundCloud support is limited without API key
        return interaction.editReply('⚠️ SoundCloud support requires API credentials. Please use YouTube links for now.\n\nTry: https://youtube.com/watch?v=...');
        
      } catch (scError) {
        return interaction.editReply('❌ Unsupported link format. Please use:\n• YouTube: https://youtube.com/watch?v=...\n• SoundCloud: https://soundcloud.com/user/track');
      }
    }
    
    // Send now playing message
    await interaction.editReply(`🎵 Now playing: **${title}**\n🔗 Source: ${source.toUpperCase()}`);
    
    // Create audio resource with FFmpeg
    const resource = createAudioResource(audioStream, {
      inlineVolume: true,
      inputType: 'arbitrary'
    });
    
    resource.volume.setVolume(0.8);
    
    // Join voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    
    // Create audio player
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });
    
    player.play(resource);
    connection.subscribe(player);
    
    // Store for cleanup
    const guildId = interaction.guildId;
    if (activePlayers.has(guildId)) {
      const old = activePlayers.get(guildId);
      if (old.connection) old.connection.destroy();
      if (old.player) old.player.stop();
    }
    
    activePlayers.set(guildId, { connection, player });
    
    // Handle player events
    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`Playback finished for ${guildId}`);
      cleanup(guildId);
    });
    
    player.on('error', (error) => {
      console.error('Player error:', error);
      interaction.followUp('❌ Playback error occurred.').catch(() => {});
      cleanup(guildId);
    });
    
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      cleanup(guildId);
    });
    
    connection.on('error', (error) => {
      console.error('Connection error:', error);
      cleanup(guildId);
    });
    
    // Handle stream errors
    audioStream.on('error', (error) => {
      console.error('Stream error:', error);
      interaction.followUp('❌ Audio stream error. The video might be unavailable.').catch(() => {});
      cleanup(guildId);
    });
    
  } catch (error) {
    console.error('General error:', error);
    await interaction.editReply('❌ Failed to play music. Please check the link and try again.\n\nCommon issues:\n• Invalid or private video\n• Age-restricted content\n• Unsupported platform');
  }
});

function cleanup(guildId) {
  const data = activePlayers.get(guildId);
  if (data) {
    if (data.connection) data.connection.destroy();
    if (data.player) data.player.stop();
    activePlayers.delete(guildId);
  }
}

// Cleanup on bot disconnect
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member.id === client.user.id && !newState.channelId) {
    cleanup(oldState.guild.id);
  }
});

// Validate token and start
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ CRITICAL: BOT_TOKEN environment variable is missing!');
  console.error('Please add it in Railway Dashboard → Variables tab');
  process.exit(1);
}

client.login(token).catch(error => {
  console.error('❌ Failed to login:', error.message);
  if (error.message.includes('token')) {
    console.error('Invalid bot token. Please check your BOT_TOKEN variable.');
  }
  process.exit(1);
});
