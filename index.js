import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import play from 'play-dl';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Wait for bot to be ready
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('ms')
      .setDescription('Play music from a link')
      .addStringOption(option =>
        option.setName('link')
          .setDescription('Music link (YouTube, Spotify, etc.)')
          .setRequired(true))
  ];
  
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  if (interaction.commandName === 'ms') {
    const link = interaction.options.getString('link');
    
    // Defer reply because music might take time
    await interaction.deferReply();
    
    // Check if user is in a voice channel
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.editReply('❌ You need to be in a voice channel first!');
    }
    
    try {
      // Validate and get music info
      const validate = await play.validate(link);
      if (!validate) {
        return interaction.editReply('❌ Invalid music link!');
      }
      
      // Get stream URL
      let streamUrl;
      if (validate === 'yt_video') {
        const video = await play.video_info(link);
        streamUrl = video.video_details.url;
      } else {
        return interaction.editReply('❌ Only YouTube links are supported for now. Spotify coming soon!');
      }
      
      // Get audio stream
      const stream = await play.stream(streamUrl);
      const resource = createAudioResource(stream.stream, {
        inputType: stream.type
      });
      
      // Join voice channel
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator
      });
      
      // Create and play audio
      const player = createAudioPlayer();
      player.play(resource);
      connection.subscribe(player);
      
      await interaction.editReply(`🎵 Now playing: ${link}`);
      
      // Handle player events
      player.on(AudioPlayerStatus.Idle, () => {
        connection.destroy();
      });
      
      player.on('error', error => {
        console.error('Player error:', error);
        interaction.followUp('❌ Error playing music');
        connection.destroy();
      });
      
    } catch (error) {
      console.error('Music error:', error);
      await interaction.editReply('❌ Failed to play music. Check the link or try again.');
    }
  }
});

client.login(process.env.BOT_TOKEN);