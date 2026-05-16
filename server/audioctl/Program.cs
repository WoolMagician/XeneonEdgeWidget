using System.Diagnostics;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace AudioCtl;

internal static class Program
{
    private const int ClsCtxAll = 23;
    private const int S_OK = 0;
    private const int DeviceStateActive = 0x00000001;
    private const int StgmRead = 0x00000000;
    private const int MaxMediaThumbnailBytes = 5 * 1024 * 1024;
    private static readonly PROPERTYKEY PkeyDeviceFriendlyName = new(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);
    private static readonly PROPERTYKEY PkeyDeviceDesc = new(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 2);
    private static readonly PROPERTYKEY PkeyDeviceInterfaceFriendlyName = new(new Guid("026E516E-B814-414B-83CD-856D6FEF4822"), 2);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    [DllImport("combase.dll")]
    private static extern int RoInitialize(uint initType);

    [DllImport("combase.dll")]
    private static extern void RoUninitialize();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

    private static int Main(string[] args)
    {
        try { SetCurrentProcessExplicitAppUserModelID("XeneonEdgeWidget.AudioCtl"); } catch { }

        if (args.Length == 0)
        {
            Console.Error.WriteLine("Missing command");
            return 1;
        }

        try
        {
            switch (args[0].ToLowerInvariant())
            {
                case "set-default-render":
                    return SetDefaultRenderEndpoint(ParseText(args, 1));
                case "set-default-capture":
                    return SetDefaultCaptureEndpoint(ParseText(args, 1));
                case "switch-default-render":
                    return SwitchDefaultRenderEndpoint(ParseText(args, 1), ParseText(args, 2));
                case "switch-default-capture":
                    return SwitchDefaultCaptureEndpoint(ParseText(args, 1), ParseText(args, 2));
                case "set-master":
                    return SetDefaultEndpointVolume(EDataFlow.Render, ParseLevel(args, 1));
                case "set-capture":
                    return SetDefaultEndpointVolume(EDataFlow.Capture, ParseLevel(args, 1));
                case "set-master-mute":
                    return SetDefaultEndpointMute(EDataFlow.Render, ParseMute(args, 1));
                case "set-capture-mute":
                    return SetDefaultEndpointMute(EDataFlow.Capture, ParseMute(args, 1));
                case "toggle-master-mute":
                    return ToggleDefaultEndpointMute(EDataFlow.Render);
                case "set-app-volume":
                    return SetAppVolume(ParseText(args, 1), ParseLevel(args, 2));
                case "set-app-mute":
                    return SetAppMute(ParseText(args, 1), ParseMute(args, 2));
                case "snapshot":
                    return WriteSnapshotJson();
                case "activity":
                    return WriteActivityJson();
                case "activity-stream":
                    return WriteActivityStream(ParseOptionalInt(args, 1, 18));
                case "media-info":
                    return WriteMediaInfoJson();
                case "media-stream":
                    return WriteMediaInfoStream(ParseOptionalInt(args, 1, 120));
                case "media-playpause":
                    return WriteMediaActionJson("playpause");
                case "media-next":
                    return WriteMediaActionJson("next");
                case "media-previous":
                    return WriteMediaActionJson("previous");
                case "media-seek":
                    return WriteMediaActionJson("seek", ParseOptionalLong(args, 1, -1));
                default:
                    Console.Error.WriteLine($"Unknown command: {args[0]}");
                    return 1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static int SetDefaultRenderEndpoint(string endpointId)
    {
        if (string.IsNullOrWhiteSpace(endpointId)) throw new ArgumentException("Invalid endpoint id");
        return SetDefaultEndpointAllRoles(endpointId);
    }

    private static int SetDefaultCaptureEndpoint(string endpointId)
    {
        if (string.IsNullOrWhiteSpace(endpointId)) throw new ArgumentException("Invalid endpoint id");
        return SetDefaultEndpointAllRoles(endpointId);
    }

    private static int SwitchDefaultRenderEndpoint(string firstEndpointId, string secondEndpointId)
    {
        if (string.IsNullOrWhiteSpace(firstEndpointId) || string.IsNullOrWhiteSpace(secondEndpointId))
            throw new ArgumentException("Invalid endpoint ids");
        if (string.Equals(firstEndpointId, secondEndpointId, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Endpoint ids must be different");

        var currentEndpointId = GetDefaultEndpointId(EDataFlow.Render, ERole.Multimedia);
        var targetEndpointId = string.Equals(currentEndpointId, firstEndpointId, StringComparison.OrdinalIgnoreCase)
            ? secondEndpointId
            : firstEndpointId;
        return SetDefaultEndpointAllRoles(targetEndpointId);
    }

    private static int SwitchDefaultCaptureEndpoint(string firstEndpointId, string secondEndpointId)
    {
        if (string.IsNullOrWhiteSpace(firstEndpointId) || string.IsNullOrWhiteSpace(secondEndpointId))
            throw new ArgumentException("Invalid endpoint ids");
        if (string.Equals(firstEndpointId, secondEndpointId, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Endpoint ids must be different");

        var currentEndpointId = GetDefaultEndpointId(EDataFlow.Capture, ERole.Multimedia);
        var targetEndpointId = string.Equals(currentEndpointId, firstEndpointId, StringComparison.OrdinalIgnoreCase)
            ? secondEndpointId
            : firstEndpointId;
        return SetDefaultEndpointAllRoles(targetEndpointId);
    }

    private static int SetDefaultEndpointAllRoles(string endpointId)
    {
        var policyObject = default(object);
        try
        {
            policyObject = new PolicyConfigClientComObject();
            foreach (var role in new[] { ERole.Console, ERole.Multimedia, ERole.Communications })
            {
                var hr = SetPolicyDefaultEndpoint(policyObject, endpointId, role);
                if (hr != S_OK) throw new COMException($"SetDefaultEndpoint({role}) failed", hr);
            }
            return 0;
        }
        finally
        {
            ReleaseCom(policyObject);
        }
    }

    private static int SetPolicyDefaultEndpoint(object policyObject, string endpointId, ERole role)
    {
        if (policyObject is IPolicyConfig policyLegacy)
        {
            return policyLegacy.SetDefaultEndpoint(endpointId, role);
        }
        if (policyObject is IPolicyConfigModern policyModern)
        {
            return policyModern.SetDefaultEndpoint(endpointId, role);
        }
        throw new COMException("IPolicyConfig interface unavailable", unchecked((int)0x80004002)); // E_NOINTERFACE
    }

    private static string GetDefaultEndpointId(EDataFlow flow, ERole role)
    {
        var enumerator = default(IMMDeviceEnumerator);
        var endpoint = default(IMMDevice);
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var hr = enumerator.GetDefaultAudioEndpoint(flow, role, out endpoint);
            if (hr != S_OK || endpoint == null) throw new COMException("GetDefaultAudioEndpoint failed", hr);
            hr = endpoint.GetId(out var endpointId);
            if (hr != S_OK || string.IsNullOrWhiteSpace(endpointId)) throw new COMException("GetId failed", hr);
            return endpointId;
        }
        finally
        {
            ReleaseCom(endpoint);
            ReleaseCom(enumerator);
        }
    }

    private static int SetDefaultEndpointVolume(EDataFlow flow, int levelPercent)
    {
        var endpoint = default(IAudioEndpointVolume);
        try
        {
            endpoint = ActivateDefaultEndpoint<IAudioEndpointVolume>(flow);
            var hr = endpoint.SetMasterVolumeLevelScalar(levelPercent / 100f, Guid.Empty);
            if (hr != S_OK) throw new COMException("SetMasterVolumeLevelScalar failed", hr);
            return 0;
        }
        finally
        {
            ReleaseCom(endpoint);
        }
    }

    private static int ToggleDefaultEndpointMute(EDataFlow flow)
    {
        var endpoint = default(IAudioEndpointVolume);
        try
        {
            endpoint = ActivateDefaultEndpoint<IAudioEndpointVolume>(flow);
            var hr = endpoint.GetMute(out var currentMute);
            if (hr != S_OK) throw new COMException("GetMute failed", hr);
            hr = endpoint.SetMute(!currentMute, Guid.Empty);
            if (hr != S_OK) throw new COMException("SetMute failed", hr);
            return 0;
        }
        finally
        {
            ReleaseCom(endpoint);
        }
    }

    private static int SetDefaultEndpointMute(EDataFlow flow, bool mute)
    {
        var endpoint = default(IAudioEndpointVolume);
        try
        {
            endpoint = ActivateDefaultEndpoint<IAudioEndpointVolume>(flow);
            var hr = endpoint.SetMute(mute, Guid.Empty);
            if (hr != S_OK) throw new COMException("SetMute failed", hr);
            return 0;
        }
        finally
        {
            ReleaseCom(endpoint);
        }
    }

    private static int SetAppVolume(string sessionId, int levelPercent)
    {
        var matches = ApplyToRenderSessions(sessionId, sessionVolume =>
        {
            var hr = sessionVolume.SetMasterVolume(levelPercent / 100f, Guid.Empty);
            if (hr != S_OK) throw new COMException("SetMasterVolume (session) failed", hr);
        });
        return matches > 0 ? 0 : 2;
    }

    private static int SetAppMute(string sessionId, bool mute)
    {
        var matches = ApplyToRenderSessions(sessionId, sessionVolume =>
        {
            var hr = sessionVolume.SetMute(mute, Guid.Empty);
            if (hr != S_OK) throw new COMException("SetMute (session) failed", hr);
        });
        return matches > 0 ? 0 : 2;
    }

    private static int WriteSnapshotJson()
    {
        var snapshot = BuildSnapshot();
        Console.Out.Write(JsonSerializer.Serialize(snapshot, JsonOptions));
        return 0;
    }

    private static int WriteActivityJson()
    {
        var activity = BuildActivitySnapshot();
        Console.Out.Write(JsonSerializer.Serialize(activity, JsonOptions));
        return 0;
    }

    private static int WriteActivityStream(int intervalMs)
    {
        var delayMs = Math.Clamp(intervalMs, 10, 1000);
        while (true)
        {
            AudioActivitySnapshot activity;
            try
            {
                activity = BuildActivitySnapshot();
            }
            catch
            {
                activity = new AudioActivitySnapshot
                {
                    Speaker = 0,
                    Apps = new List<AudioSessionActivitySnapshot>(),
                };
            }

            try
            {
                Console.Out.WriteLine(JsonSerializer.Serialize(activity, JsonOptions));
                Console.Out.Flush();
            }
            catch (System.IO.IOException)
            {
                return 0;
            }
            catch (ObjectDisposedException)
            {
                return 0;
            }

            System.Threading.Thread.Sleep(delayMs);
        }
    }

    private static int WriteMediaInfoJson()
    {
        MediaInfoSnapshot snapshot;
        try
        {
            snapshot = BuildMediaInfoSnapshotAsync(includeThumbnail: true).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            snapshot = MediaInfoSnapshot.Unavailable(ex.Message);
        }

        Console.Out.Write(JsonSerializer.Serialize(snapshot, JsonOptions));
        return 0;
    }

    private static int WriteMediaInfoStream(int intervalMs)
    {
        var delayMs = Math.Clamp(intervalMs, 70, 500);
        string lastKey = string.Empty;
        string? lastThumbnail = null;

        while (true)
        {
            MediaInfoSnapshot snapshot;
            try
            {
                snapshot = BuildMediaInfoSnapshotAsync(includeThumbnail: false).GetAwaiter().GetResult();
                var key = BuildMediaTrackKey(snapshot);

                if (!string.IsNullOrWhiteSpace(key))
                {
                    if (!string.Equals(key, lastKey, StringComparison.Ordinal))
                    {
                        try
                        {
                            var detailed = BuildMediaInfoSnapshotAsync(includeThumbnail: true).GetAwaiter().GetResult();
                            var detailedKey = BuildMediaTrackKey(detailed);
                            if (string.Equals(detailedKey, key, StringComparison.Ordinal))
                            {
                                snapshot = detailed;
                            }
                        }
                        catch
                        {
                            // Best effort only; stream should keep running.
                        }
                    }

                    if (string.IsNullOrWhiteSpace(snapshot.Thumbnail) && string.Equals(key, lastKey, StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(lastThumbnail))
                    {
                        snapshot.Thumbnail = lastThumbnail;
                    }

                    if (!string.IsNullOrWhiteSpace(snapshot.Thumbnail))
                    {
                        lastThumbnail = snapshot.Thumbnail;
                    }

                    lastKey = key;
                }
                else
                {
                    lastKey = string.Empty;
                    lastThumbnail = null;
                }
            }
            catch (Exception ex)
            {
                snapshot = MediaInfoSnapshot.Unavailable(ex.Message);
                lastKey = string.Empty;
                lastThumbnail = null;
            }

            try
            {
                Console.Out.WriteLine(JsonSerializer.Serialize(snapshot, JsonOptions));
                Console.Out.Flush();
            }
            catch (System.IO.IOException)
            {
                return 0;
            }
            catch (ObjectDisposedException)
            {
                return 0;
            }

            System.Threading.Thread.Sleep(delayMs);
        }
    }

    private static int WriteMediaActionJson(string action, long targetSeconds = -1)
    {
        MediaActionResult result;
        try
        {
            result = ExecuteMediaActionAsync(action, targetSeconds).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            result = new MediaActionResult
            {
                Ok = false,
                Position = 0,
                Duration = 0,
                Error = ex.Message,
            };
        }

        Console.Out.Write(JsonSerializer.Serialize(result, JsonOptions));
        return 0;
    }

    private static async Task<MediaInfoSnapshot> BuildMediaInfoSnapshotAsync(bool includeThumbnail = true)
    {
        var roInit = TryInitializeWinRt();
        try
        {
        var manager = await AwaitAsync(
            GlobalSystemMediaTransportControlsSessionManager.RequestAsync(),
            5500,
            "manager.request");

        var currentSession = manager.GetCurrentSession();
        var sessions = manager.GetSessions();
        var candidates = new List<MediaSessionCandidate>();

        if (sessions != null)
        {
            foreach (var session in sessions)
            {
                try
                {
                    candidates.Add(await BuildMediaCandidateAsync(session, session == currentSession));
                }
                catch
                {
                    // Ignore broken sessions and continue.
                }
            }
        }

        if (candidates.Count == 0 && currentSession != null)
        {
            try
            {
                candidates.Add(await BuildMediaCandidateAsync(currentSession, true));
            }
            catch
            {
                // Ignore: will fall back to Closed snapshot below.
            }
        }

        var selected = candidates
            .OrderByDescending(item => item.Score)
            .FirstOrDefault();

        if (selected == null)
        {
            return MediaInfoSnapshot.Closed();
        }

        var thumbnail = includeThumbnail ? await ReadMediaThumbnailAsync(selected.ThumbnailRef) : null;
        return new MediaInfoSnapshot
        {
            Active = true,
            App = selected.App,
            Source = selected.Source,
            Title = selected.Title,
            Artist = selected.Artist,
            Album = selected.Album,
            PlaybackStatus = selected.PlaybackStatus,
            Thumbnail = thumbnail,
            Position = selected.Position,
            Duration = selected.Duration,
            Score = selected.Score,
        };
        }
        finally
        {
            CleanupWinRtInit(roInit);
        }
    }

    private static string BuildMediaTrackKey(MediaInfoSnapshot snapshot)
    {
        if (snapshot == null || !snapshot.Active) return string.Empty;
        var app = (snapshot.App ?? string.Empty).Trim().ToLowerInvariant();
        var source = (snapshot.Source ?? string.Empty).Trim().ToLowerInvariant();
        var title = (snapshot.Title ?? string.Empty).Trim().ToLowerInvariant();
        var artist = (snapshot.Artist ?? snapshot.Album ?? string.Empty).Trim().ToLowerInvariant();
        return $"{app}|{source}|{title}|{artist}";
    }

    private static async Task<MediaActionResult> ExecuteMediaActionAsync(string action, long targetSeconds)
    {
        var roInit = TryInitializeWinRt();
        try
        {
        var manager = await AwaitAsync(
            GlobalSystemMediaTransportControlsSessionManager.RequestAsync(),
            5500,
            "manager.request");

        var session = await ResolvePrimaryMediaSessionAsync(manager);
        if (session == null)
        {
            return new MediaActionResult
            {
                Ok = false,
                Position = 0,
                Duration = 0,
                Error = "No media session",
            };
        }

        var normalizedAction = (action ?? string.Empty).Trim().ToLowerInvariant();
        var ok = false;
        switch (normalizedAction)
        {
            case "playpause":
                ok = await AwaitAsync(session.TryTogglePlayPauseAsync(), 1800, "action.playpause");
                break;
            case "next":
                ok = await AwaitAsync(session.TrySkipNextAsync(), 1800, "action.next");
                break;
            case "previous":
                ok = await AwaitAsync(session.TrySkipPreviousAsync(), 1800, "action.previous");
                break;
            case "seek":
            {
                var timeline = session.GetTimelineProperties();
                var duration = CalculateTimelineDurationSeconds(timeline);
                var seekPosition = Math.Max(0L, targetSeconds);
                if (duration > 0)
                {
                    seekPosition = Math.Min(seekPosition, duration);
                }

                var ticks = seekPosition * TimeSpan.TicksPerSecond;
                ok = await AwaitAsync(session.TryChangePlaybackPositionAsync(ticks), 2000, "action.seek");
                return new MediaActionResult
                {
                    Ok = ok,
                    Position = (int)seekPosition,
                    Duration = duration,
                };
            }
            default:
                return new MediaActionResult
                {
                    Ok = false,
                    Position = 0,
                    Duration = 0,
                    Error = "Unsupported media action",
                };
        }

        return new MediaActionResult
        {
            Ok = ok,
            Position = 0,
            Duration = 0,
        };
        }
        finally
        {
            CleanupWinRtInit(roInit);
        }
    }

    private static async Task<GlobalSystemMediaTransportControlsSession?> ResolvePrimaryMediaSessionAsync(
        GlobalSystemMediaTransportControlsSessionManager manager)
    {
        var current = manager.GetCurrentSession();
        var sessions = manager.GetSessions();
        var candidates = new List<MediaSessionCandidate>();

        if (sessions != null)
        {
            foreach (var session in sessions)
            {
                try
                {
                    candidates.Add(await BuildMediaCandidateAsync(session, session == current));
                }
                catch
                {
                    // Ignore broken sessions and continue.
                }
            }
        }

        if (candidates.Count == 0 && current != null) return current;
        return candidates.OrderByDescending(item => item.Score).FirstOrDefault()?.Session ?? current;
    }

    private static async Task<MediaSessionCandidate> BuildMediaCandidateAsync(
        GlobalSystemMediaTransportControlsSession session,
        bool isCurrent)
    {
        var props = await AwaitAsync(
            session.TryGetMediaPropertiesAsync(),
            1800,
            "session.mediaProps");

        var playback = session.GetPlaybackInfo();
        var timeline = session.GetTimelineProperties();

        var source = session.SourceAppUserModelId ?? string.Empty;
        var title = props?.Title ?? string.Empty;
        var artist = props?.Artist ?? string.Empty;
        var album = props?.AlbumTitle ?? string.Empty;
        var status = playback.PlaybackStatus.ToString();
        var app = GetMediaAppName(source, title, album);

        if (string.Equals(app, "Spotify", StringComparison.OrdinalIgnoreCase)
            && string.IsNullOrWhiteSpace(artist)
            && title.Contains(" - ", StringComparison.Ordinal))
        {
            var pieces = title.Split(" - ", 2, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            if (pieces.Length == 2)
            {
                artist = pieces[0];
                title = pieces[1];
            }
        }

        var duration = CalculateTimelineDurationSeconds(timeline);
        var position = CalculateTimelinePositionSeconds(timeline, duration);

        var score = 0;
        if (string.Equals(status, "Playing", StringComparison.OrdinalIgnoreCase)) score += 1000;
        else if (string.Equals(status, "Paused", StringComparison.OrdinalIgnoreCase)) score += 300;
        else if (string.Equals(status, "Stopped", StringComparison.OrdinalIgnoreCase)) score += 50;
        if (!string.IsNullOrWhiteSpace(title)) score += 120;
        if (!string.IsNullOrWhiteSpace(artist)) score += 40;
        if (Regex.IsMatch(app, "Spotify|YouTube|Jellyfin|Browser", RegexOptions.IgnoreCase)) score += 80;
        if (Regex.IsMatch($"{title} {album} {source}", "Jellyfin", RegexOptions.IgnoreCase)) score += 220;
        if (isCurrent) score += 15;
        if (Regex.IsMatch(source, "ShellExperienceHost|System|Windows", RegexOptions.IgnoreCase)) score -= 500;
        if (Regex.IsMatch(title, "Microsoft|Windows|Operating System", RegexOptions.IgnoreCase)) score -= 500;

        return new MediaSessionCandidate
        {
            Session = session,
            Score = score,
            Source = source,
            App = app,
            Title = title,
            Artist = artist,
            Album = album,
            PlaybackStatus = status,
            Position = position,
            Duration = duration,
            ThumbnailRef = props?.Thumbnail,
        };
    }

    private static int CalculateTimelineDurationSeconds(GlobalSystemMediaTransportControlsSessionTimelineProperties timeline)
    {
        try
        {
            var seconds = (timeline.EndTime - timeline.StartTime).TotalSeconds;
            return Math.Max(0, (int)Math.Round(seconds));
        }
        catch
        {
            return 0;
        }
    }

    private static double CalculateTimelinePositionSeconds(
        GlobalSystemMediaTransportControlsSessionTimelineProperties timeline,
        int duration)
    {
        try
        {
            var seconds = Math.Max(0d, (timeline.Position - timeline.StartTime).TotalSeconds);

            if (duration > 0) seconds = Math.Min(duration, seconds);
            return Math.Round(seconds, 3, MidpointRounding.AwayFromZero);
        }
        catch
        {
            return 0d;
        }
    }

    private static DateTime? TryGetTimelineLastUpdatedUtc(GlobalSystemMediaTransportControlsSessionTimelineProperties timeline)
    {
        try
        {
            return timeline.LastUpdatedTime.UtcDateTime;
        }
        catch
        {
            return null;
        }
    }

    private static async Task<string?> ReadMediaThumbnailAsync(IRandomAccessStreamReference? thumbnailRef)
    {
        if (thumbnailRef == null) return null;
        try
        {
            using var stream = await AwaitAsync(thumbnailRef.OpenReadAsync(), 900, "thumb.open");
            if (stream == null || stream.Size == 0 || stream.Size > MaxMediaThumbnailBytes) return null;

            using var input = stream.GetInputStreamAt(0);
            using var reader = new DataReader(input);
            await AwaitAsync(reader.LoadAsync((uint)stream.Size), 1200, "thumb.read");

            var bytes = new byte[(int)stream.Size];
            reader.ReadBytes(bytes);

            var contentType = string.IsNullOrWhiteSpace(stream.ContentType)
                ? "image/jpeg"
                : stream.ContentType;

            return $"data:{contentType};base64,{Convert.ToBase64String(bytes)}";
        }
        catch
        {
            return null;
        }
    }

    private static async Task<T> AwaitAsync<T>(IAsyncOperation<T> operation, int timeoutMs, string stage)
    {
        var safeTimeout = Math.Max(250, timeoutMs);
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

        operation.Completed = (op, status) =>
        {
            try
            {
                switch (status)
                {
                    case AsyncStatus.Completed:
                        tcs.TrySetResult(op.GetResults());
                        break;
                    case AsyncStatus.Canceled:
                        tcs.TrySetException(new OperationCanceledException($"Async canceled at {stage}"));
                        break;
                    case AsyncStatus.Error:
                    {
                        var ex = op.ErrorCode ?? new Exception($"Async error at {stage}");
                        tcs.TrySetException(ex);
                        break;
                    }
                    default:
                        tcs.TrySetException(new TimeoutException($"Async incomplete at {stage}"));
                        break;
                }
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
        };

        var completed = await Task.WhenAny(tcs.Task, Task.Delay(safeTimeout)).ConfigureAwait(false);
        if (completed != tcs.Task)
        {
            throw new TimeoutException($"Async timeout at {stage} ({safeTimeout}ms)");
        }

        return await tcs.Task.ConfigureAwait(false);
    }

    private static string GetMediaAppName(string source, string title, string album)
    {
        if (Regex.IsMatch($"{source} {title} {album}", "Jellyfin", RegexOptions.IgnoreCase)) return "Jellyfin";
        if (Regex.IsMatch(source, "Spotify", RegexOptions.IgnoreCase)) return "Spotify";
        if (Regex.IsMatch($"{title} {album}", "YouTube", RegexOptions.IgnoreCase)) return "YouTube";
        if (Regex.IsMatch(source, "Chrome|MSEdge|Firefox|Brave|Opera", RegexOptions.IgnoreCase)) return "YouTube";
        if (Regex.IsMatch(source, "ZuneMusic|ZuneVideo|MicrosoftMediaPlayer|WindowsMediaPlayer", RegexOptions.IgnoreCase)) return "Lettore Multimediale";
        if (Regex.IsMatch(source, "Music", RegexOptions.IgnoreCase)) return "Music";
        if (string.IsNullOrWhiteSpace(source)) return "Media";

        var sourceTrimmed = source.Trim();
        var packageMatch = Regex.Match(sourceTrimmed, @"^(?:[^.]+\.)+([^._!]+)[_!]");
        if (packageMatch.Success)
        {
            var value = packageMatch.Groups[1].Value.Trim();
            if (!string.IsNullOrWhiteSpace(value)) return value;
        }

        return sourceTrimmed;
    }

    private static int TryInitializeWinRt()
    {
        try
        {
            return RoInitialize(1);
        }
        catch
        {
            return int.MinValue;
        }
    }

    private static void CleanupWinRtInit(int roResult)
    {
        if (roResult >= 0)
        {
            try { RoUninitialize(); } catch { }
        }
    }

    private static AudioActivitySnapshot BuildActivitySnapshot()
    {
        return new AudioActivitySnapshot
        {
            Speaker = ReadDefaultRenderActivity(),
            Apps = EnumerateRenderSessionActivity(),
        };
    }

    private static AudioSnapshot BuildSnapshot()
    {
        var speakers = EnumerateEndpoints(EDataFlow.Render);
        var mics = EnumerateEndpoints(EDataFlow.Capture);
        var defaultSpeakerEndpointId = TryGetDefaultEndpointId(EDataFlow.Render, ERole.Multimedia);
        var defaultMicEndpointId = TryGetDefaultEndpointId(EDataFlow.Capture, ERole.Multimedia);

        foreach (var speaker in speakers)
        {
            speaker.IsDefault = string.Equals(speaker.EndpointId, defaultSpeakerEndpointId, StringComparison.OrdinalIgnoreCase);
        }

        foreach (var mic in mics)
        {
            mic.IsDefault = string.Equals(mic.EndpointId, defaultMicEndpointId, StringComparison.OrdinalIgnoreCase);
        }

        var apps = EnumerateRenderSessions();
        return new AudioSnapshot
        {
            Speaker = speakers.FirstOrDefault(item => item.IsDefault) ?? speakers.FirstOrDefault(),
            Mic = mics.FirstOrDefault(item => item.IsDefault) ?? mics.FirstOrDefault(),
            Speakers = speakers,
            Mics = mics,
            Apps = apps,
        };
    }

    private static int ReadDefaultRenderActivity()
    {
        var enumerator = default(IMMDeviceEnumerator);
        var device = default(IMMDevice);
        var meter = default(IAudioMeterInformation);
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out device);
            if (hr != S_OK || device == null) return 0;

            meter = ActivateEndpoint<IAudioMeterInformation>(device);
            if (meter == null) return 0;
            if (meter.GetPeakValue(out var peak) != S_OK) return 0;
            return NormalizePeakPercent(peak);
        }
        catch
        {
            return 0;
        }
        finally
        {
            ReleaseCom(meter);
            ReleaseCom(device);
            ReleaseCom(enumerator);
        }
    }

    private static List<AudioSessionActivitySnapshot> EnumerateRenderSessionActivity()
    {
        var manager = default(IAudioSessionManager2);
        var enumerator = default(IAudioSessionEnumerator);
        var control = default(IAudioSessionControl);
        var control2 = default(IAudioSessionControl2);
        var meter = default(IAudioMeterInformation);
        var byId = new Dictionary<string, AudioSessionActivitySnapshot>(StringComparer.OrdinalIgnoreCase);

        try
        {
            manager = ActivateDefaultEndpoint<IAudioSessionManager2>(EDataFlow.Render);
            var hr = manager.GetSessionEnumerator(out enumerator);
            if (hr != S_OK || enumerator == null) return byId.Values.ToList();
            hr = enumerator.GetCount(out var sessionCount);
            if (hr != S_OK) return byId.Values.ToList();

            for (var i = 0; i < sessionCount; i++)
            {
                ReleaseCom(meter);
                meter = null;
                ReleaseCom(control2);
                control2 = null;
                ReleaseCom(control);
                control = null;

                hr = enumerator.GetSession(i, out control);
                if (hr != S_OK || control == null) continue;

                control2 = control as IAudioSessionControl2;
                if (control2 == null) continue;

                var label = string.Empty;
                var pid = 0u;
                var sessionId = string.Empty;
                control2.GetProcessId(out pid);
                if (control.GetState(out var stateRaw) != S_OK || stateRaw != 1) continue;
                if (control.GetDisplayName(out var displayName) == S_OK) label = displayName ?? string.Empty;
                if (control2.GetSessionIdentifier(out var rawSessionId) == S_OK) sessionId = rawSessionId ?? string.Empty;
                var isSystem = ProgramExtensions.IsSystemSoundsSession(control2, pid, string.Empty, label, sessionId);
                var token = BuildSessionToken(string.Empty, label, sessionId, isSystem);
                if (string.IsNullOrWhiteSpace(token)) continue;
                if (token.Equals("qtwebengineprocess.exe", StringComparison.OrdinalIgnoreCase)) continue;

                meter = control as IAudioMeterInformation;
                var peakValue = 0f;
                if (meter != null) meter.GetPeakValue(out peakValue);
                var activity = NormalizePeakPercent(peakValue);
                if (activity <= 0) continue;

                if (byId.TryGetValue(token, out var existing))
                {
                    if (activity > existing.Activity)
                    {
                        existing.Activity = activity;
                        existing.ProcessId = pid;
                    }
                }
                else
                {
                    byId[token] = new AudioSessionActivitySnapshot
                    {
                        Id = token,
                        ProcessId = pid,
                        Activity = activity,
                    };
                }
            }
        }
        finally
        {
            ReleaseCom(meter);
            ReleaseCom(control2);
            ReleaseCom(control);
            ReleaseCom(enumerator);
            ReleaseCom(manager);
        }

        return byId.Values.OrderBy(item => item.Id, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static int NormalizePeakPercent(float peakValue)
    {
        if (float.IsNaN(peakValue) || float.IsInfinity(peakValue)) return 0;
        var clamped = Math.Clamp(peakValue, 0f, 1f);
        return Math.Clamp((int)Math.Round(clamped * 100f), 0, 100);
    }

    private static List<AudioEndpointSnapshot> EnumerateEndpoints(EDataFlow flow)
    {
        var enumerator = default(IMMDeviceEnumerator);
        var collection = default(IMMDeviceCollection);
        var device = default(IMMDevice);
        var endpointVolume = default(IAudioEndpointVolume);
        var results = new List<AudioEndpointSnapshot>();

        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var hr = enumerator.EnumAudioEndpoints(flow, DeviceStateActive, out collection);
            if (hr != S_OK || collection == null) throw new COMException("EnumAudioEndpoints failed", hr);

            hr = collection.GetCount(out var count);
            if (hr != S_OK) throw new COMException("IMMDeviceCollection.GetCount failed", hr);

            for (uint index = 0; index < count; index++)
            {
                ReleaseCom(endpointVolume);
                endpointVolume = null;
                ReleaseCom(device);
                device = null;

                hr = collection.Item(index, out device);
                if (hr != S_OK || device == null) continue;

                if (device.GetId(out var endpointId) != S_OK || string.IsNullOrWhiteSpace(endpointId)) continue;
                device.GetState(out var stateRaw);

                var friendlyName = ReadEndpointRegistryValue(flow, endpointId, "{a45c254e-df1c-4efd-8020-67d146a850e0},14");
                var deviceDesc = ReadEndpointRegistryValue(flow, endpointId, "{a45c254e-df1c-4efd-8020-67d146a850e0},2");
                var interfaceName = ReadEndpointRegistryValue(flow, endpointId, "{026e516e-b814-414b-83cd-856d6fef4822},2");

                if (string.IsNullOrWhiteSpace(friendlyName))
                    friendlyName = ReadDevicePropertyString(device, PkeyDeviceFriendlyName);
                if (string.IsNullOrWhiteSpace(deviceDesc))
                    deviceDesc = ReadDevicePropertyString(device, PkeyDeviceDesc);
                if (string.IsNullOrWhiteSpace(interfaceName))
                    interfaceName = ReadDevicePropertyString(device, PkeyDeviceInterfaceFriendlyName);

                var displayName = FirstNonEmpty(friendlyName, deviceDesc, interfaceName, endpointId);
                var label = FirstNonEmpty(deviceDesc, interfaceName, displayName);

                var volumePercent = 0;
                var muted = false;
                endpointVolume = ActivateEndpoint<IAudioEndpointVolume>(device);
                if (endpointVolume != null)
                {
                    if (endpointVolume.GetMasterVolumeLevelScalar(out var level) == S_OK)
                        volumePercent = Math.Clamp((int)Math.Round(level * 100f), 0, 100);
                    endpointVolume.GetMute(out muted);
                }

                results.Add(new AudioEndpointSnapshot
                {
                    Name = displayName,
                    Label = label,
                    Id = endpointId,
                    EndpointId = endpointId,
                    IsDefault = false,
                    Volume = volumePercent,
                    Muted = muted,
                    State = stateRaw == DeviceStateActive ? "Active" : "Unknown",
                });
            }
        }
        finally
        {
            ReleaseCom(endpointVolume);
            ReleaseCom(device);
            ReleaseCom(collection);
            ReleaseCom(enumerator);
        }

        return results;
    }

    private static List<AudioSessionSnapshot> EnumerateRenderSessions()
    {
        var deviceEnumerator = default(IMMDeviceEnumerator);
        var deviceCollection = default(IMMDeviceCollection);
        var device = default(IMMDevice);
        var manager = default(IAudioSessionManager2);
        var enumerator = default(IAudioSessionEnumerator);
        var control = default(IAudioSessionControl);
        var control2 = default(IAudioSessionControl2);
        var volume = default(ISimpleAudioVolume);
        var results = new List<AudioSessionSnapshot>();

        try
        {
            deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var hr = deviceEnumerator.EnumAudioEndpoints(EDataFlow.Render, DeviceStateActive, out deviceCollection);
            if (hr != S_OK || deviceCollection == null) throw new COMException("EnumAudioEndpoints failed", hr);
            hr = deviceCollection.GetCount(out var deviceCount);
            if (hr != S_OK) throw new COMException("IMMDeviceCollection.GetCount failed", hr);

            for (uint deviceIndex = 0; deviceIndex < deviceCount; deviceIndex++)
            {
                ReleaseCom(enumerator);
                enumerator = null;
                ReleaseCom(manager);
                manager = null;
                ReleaseCom(device);
                device = null;

                hr = deviceCollection.Item(deviceIndex, out device);
                if (hr != S_OK || device == null) continue;

                manager = ActivateEndpoint<IAudioSessionManager2>(device);
                if (manager == null) continue;

                hr = manager.GetSessionEnumerator(out enumerator);
                if (hr != S_OK || enumerator == null) continue;

                hr = enumerator.GetCount(out var count);
                if (hr != S_OK) continue;

                for (var i = 0; i < count; i++)
                {
                    ReleaseCom(volume);
                    volume = null;
                    ReleaseCom(control2);
                    control2 = null;
                    ReleaseCom(control);
                    control = null;

                    hr = enumerator.GetSession(i, out control);
                    if (hr != S_OK || control == null) continue;

                    control2 = control as IAudioSessionControl2;
                    volume = control as ISimpleAudioVolume;
                    if (control2 == null || volume == null) continue;

                    control.GetState(out var stateRaw);
                    var state = SessionStateToText(stateRaw);

                    var label = string.Empty;
                    var title = string.Empty;
                    var processName = string.Empty;
                    var pid = 0u;
                    var sessionId = string.Empty;

                    control2.GetProcessId(out pid);
                    processName = pid > 0 ? GetProcessNameSafe((int)pid) : string.Empty;
                    title = pid > 0 ? GetProcessWindowTitleSafe((int)pid) : string.Empty;
                    if (control.GetDisplayName(out var displayName) == S_OK) label = displayName ?? string.Empty;
                    if (control2.GetSessionIdentifier(out var rawSessionId) == S_OK) sessionId = rawSessionId ?? string.Empty;
                    var isSystem = ProgramExtensions.IsSystemSoundsSession(control2, pid, processName, label, sessionId);
                    var token = BuildSessionToken(processName, label, sessionId, isSystem);
                    if (string.IsNullOrWhiteSpace(token)) continue;

                    var sessionVolume = 0;
                    var muted = false;
                    if (volume.GetMasterVolume(out var level) == S_OK)
                        sessionVolume = Math.Clamp((int)Math.Round(level * 100f), 0, 100);
                    volume.GetMute(out muted);

                    var display = FirstNonEmpty(label, processName, isSystem ? "System Sounds" : string.Empty, token);
                    var resolvedLabel = FirstNonEmpty(processName, label, display);
                    results.Add(new AudioSessionSnapshot
                    {
                        Id = token,
                        Name = display,
                        Label = resolvedLabel,
                        Title = title,
                        Volume = sessionVolume,
                        Muted = muted,
                        State = state,
                        ProcessId = pid,
                        IsSystem = isSystem,
                    });
                }
            }
        }
        finally
        {
            ReleaseCom(volume);
            ReleaseCom(control2);
            ReleaseCom(control);
            ReleaseCom(enumerator);
            ReleaseCom(manager);
            ReleaseCom(device);
            ReleaseCom(deviceCollection);
            ReleaseCom(deviceEnumerator);
        }

        return results;
    }

    private static string BuildSessionToken(string processName, string displayName, string sessionIdentifier, bool isSystem)
    {
        if (isSystem) return "System Sounds";
        return ProgramExtensions.BuildStableSessionToken(processName, displayName, sessionIdentifier);
    }

    private static string SessionStateToText(int state)
    {
        return state switch
        {
            1 => "Active",
            2 => "Expired",
            _ => "Inactive",
        };
    }

    private static string TryGetDefaultEndpointId(EDataFlow flow, ERole role)
    {
        try
        {
            return GetDefaultEndpointId(flow, role);
        }
        catch
        {
            return string.Empty;
        }
    }

    private static int ApplyToRenderSessions(string sessionId, Action<ISimpleAudioVolume> applyAction)
    {
        var selector = ParseSessionSelector(sessionId);
        var deviceEnumerator = default(IMMDeviceEnumerator);
        var deviceCollection = default(IMMDeviceCollection);
        var device = default(IMMDevice);
        var manager = default(IAudioSessionManager2);
        var enumerator = default(IAudioSessionEnumerator);
        var control = default(IAudioSessionControl);
        var control2 = default(IAudioSessionControl2);
        var volume = default(ISimpleAudioVolume);
        var matchCount = 0;

        try
        {
            deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var hr = deviceEnumerator.EnumAudioEndpoints(EDataFlow.Render, DeviceStateActive, out deviceCollection);
            if (hr != S_OK || deviceCollection == null) throw new COMException("EnumAudioEndpoints failed", hr);
            hr = deviceCollection.GetCount(out var deviceCount);
            if (hr != S_OK) throw new COMException("IMMDeviceCollection.GetCount failed", hr);

            for (uint deviceIndex = 0; deviceIndex < deviceCount; deviceIndex++)
            {
                ReleaseCom(enumerator);
                enumerator = null;
                ReleaseCom(manager);
                manager = null;
                ReleaseCom(device);
                device = null;

                hr = deviceCollection.Item(deviceIndex, out device);
                if (hr != S_OK || device == null) continue;

                manager = ActivateEndpoint<IAudioSessionManager2>(device);
                if (manager == null) continue;

                hr = manager.GetSessionEnumerator(out enumerator);
                if (hr != S_OK || enumerator == null) continue;

                hr = enumerator.GetCount(out var count);
                if (hr != S_OK) continue;

                for (var i = 0; i < count; i++)
                {
                    ReleaseCom(volume);
                    volume = null;
                    ReleaseCom(control2);
                    control2 = null;
                    ReleaseCom(control);
                    control = null;

                    hr = enumerator.GetSession(i, out control);
                    if (hr != S_OK || control == null) continue;

                    control2 = control as IAudioSessionControl2;
                    if (control2 == null) continue;
                    volume = control as ISimpleAudioVolume;
                    if (volume == null) continue;

                    if (!IsSessionMatch(control2, selector)) continue;
                    applyAction(volume);
                    matchCount++;
                }
            }
        }
        finally
        {
            ReleaseCom(volume);
            ReleaseCom(control2);
            ReleaseCom(control);
            ReleaseCom(enumerator);
            ReleaseCom(manager);
            ReleaseCom(device);
            ReleaseCom(deviceCollection);
            ReleaseCom(deviceEnumerator);
        }

        return matchCount;
    }


    private static SessionSelector ParseSessionSelector(string value)
    {
        var raw = (value ?? string.Empty).Trim();
        var tokenSource = raw;
        var appIdx = raw.IndexOf("\\Application\\", StringComparison.OrdinalIgnoreCase);
        if (appIdx >= 0)
        {
            tokenSource = raw[(appIdx + "\\Application\\".Length)..];
        }

        tokenSource = Path.GetFileName(tokenSource.Replace('/', '\\'));
        var token = NormalizeToken(tokenSource);
        var isSystem = token is "sy" or "systemsounds" or "systemsound";
        return new SessionSelector(token, isSystem);
    }

    private static bool IsSessionMatch(IAudioSessionControl2 session, SessionSelector selector)
    {
        if (selector.IsSystem)
        {
            session.GetProcessId(out var systemPid);
            var processName = systemPid > 0 ? GetProcessNameSafe((int)systemPid) : string.Empty;
            var displayName = string.Empty;
            var systemSessionIdentifier = string.Empty;
            if (session.GetDisplayName(out var rawDisplay) == S_OK) displayName = rawDisplay ?? string.Empty;
            if (session.GetSessionIdentifier(out var rawSessionId) == S_OK) systemSessionIdentifier = rawSessionId ?? string.Empty;
            return ProgramExtensions.IsSystemSoundsSession(session, systemPid, processName, displayName, systemSessionIdentifier);
        }

        if (string.IsNullOrWhiteSpace(selector.Token)) return false;

        var hr = session.GetProcessId(out var pid);
        if (hr == S_OK && pid > 0)
        {
            var processName = GetProcessNameSafe((int)pid);
            if (NormalizeToken(processName) == selector.Token) return true;
        }

        if (session.GetSessionIdentifier(out var sessionIdentifier) == S_OK)
        {
            if (NormalizeToken(sessionIdentifier).Contains(selector.Token, StringComparison.Ordinal)) return true;
        }

        if (session.GetSessionInstanceIdentifier(out var instanceIdentifier) == S_OK)
        {
            if (NormalizeToken(instanceIdentifier).Contains(selector.Token, StringComparison.Ordinal)) return true;
        }

        return false;
    }

    private static string GetProcessNameSafe(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string GetProcessWindowTitleSafe(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.MainWindowTitle ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string FirstNonEmpty(params string[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return string.Empty;
    }

    private static string ReadDevicePropertyString(IMMDevice device, PROPERTYKEY key)
    {
        var store = default(IPropertyStore);
        try
        {
            var hr = device.OpenPropertyStore(StgmRead, out var storeObj);
            if (hr != S_OK || storeObj == null) return string.Empty;
            store = (IPropertyStore)storeObj;
            hr = store.GetValue(ref key, out var valueObj);
            if (hr != S_OK) return string.Empty;
            if (valueObj == null) return string.Empty;
            if (valueObj is string text) return text.Trim();
            return valueObj.ToString()?.Trim() ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
        finally
        {
            ReleaseCom(store);
        }
    }

    private static string ReadEndpointRegistryValue(EDataFlow flow, string endpointId, string propertyName)
    {
        try
        {
            var branch = flow == EDataFlow.Capture ? "Capture" : "Render";
            var guid = ExtractEndpointGuid(endpointId);
            if (string.IsNullOrWhiteSpace(guid)) return string.Empty;
            var path = $@"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\{branch}\{guid}\Properties";
            using var key = Registry.LocalMachine.OpenSubKey(path, writable: false);
            var value = key?.GetValue(propertyName);
            return value?.ToString()?.Trim() ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string ExtractEndpointGuid(string endpointId)
    {
        var match = Regex.Match(endpointId ?? string.Empty, @"\{([0-9a-fA-F-]{36})\}\s*$");
        if (!match.Success) return string.Empty;
        return "{" + match.Groups[1].Value + "}";
    }

    private static T? ActivateEndpoint<T>(IMMDevice device) where T : class
    {
        var iid = typeof(T).GUID;
        var hr = device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var endpointObj);
        if (hr != S_OK || endpointObj == null) return null;
        return (T)endpointObj;
    }

    private static T ActivateDefaultEndpoint<T>(EDataFlow flow) where T : class
    {
        var enumerator = default(IMMDeviceEnumerator);
        var device = default(IMMDevice);
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var hr = enumerator.GetDefaultAudioEndpoint(flow, ERole.Multimedia, out device);
            if (hr != S_OK || device == null) throw new COMException("GetDefaultAudioEndpoint failed", hr);
            var iid = typeof(T).GUID;
            hr = device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var endpointObj);
            if (hr != S_OK || endpointObj == null) throw new COMException($"Activate {typeof(T).Name} failed", hr);
            return (T)endpointObj;
        }
        finally
        {
            ReleaseCom(device);
            ReleaseCom(enumerator);
        }
    }

    private static int ParseLevel(string[] args, int index)
    {
        var raw = ParseText(args, index);
        if (!int.TryParse(raw, out var level)) throw new ArgumentException("Invalid level");
        if (level < 0) level = 0;
        if (level > 100) level = 100;
        return level;
    }

    private static bool ParseMute(string[] args, int index)
    {
        var raw = ParseText(args, index).Trim().ToLowerInvariant();
        return raw is "1" or "true" or "yes" or "on";
    }

    private static string ParseText(string[] args, int index)
    {
        if (index < 0 || index >= args.Length) throw new ArgumentException("Missing argument");
        var value = args[index]?.Trim();
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException("Invalid argument");
        return value;
    }

    private static int ParseOptionalInt(string[] args, int index, int fallback)
    {
        if (index < 0 || index >= args.Length) return fallback;
        var raw = args[index]?.Trim();
        if (!int.TryParse(raw, out var parsed)) return fallback;
        return parsed;
    }

    private static long ParseOptionalLong(string[] args, int index, long fallback)
    {
        if (index < 0 || index >= args.Length) return fallback;
        var raw = args[index]?.Trim();
        if (!long.TryParse(raw, out var parsed)) return fallback;
        return parsed;
    }

    private static string NormalizeToken(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var lower = value.Trim().ToLowerInvariant();
        if (lower.EndsWith(".exe", StringComparison.Ordinal)) lower = lower[..^4];
        var chars = lower.Where(char.IsLetterOrDigit).ToArray();
        return new string(chars);
    }

    private static void ReleaseCom(object? instance)
    {
        if (instance == null) return;
        try
        {
            if (Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance);
        }
        catch
        {
            // No-op: best-effort COM cleanup.
        }
    }
}

internal static partial class ProgramExtensions
{
    public static bool IsSystemSoundsSession(
        IAudioSessionControl2 session,
        uint pid,
        string processName,
        string displayName,
        string sessionIdentifier)
    {
        var hr = session.IsSystemSoundsSession();
        if (hr == 0 && pid == 0) return true;

        var normalizedProcess = NormalizeTokenLocal(processName);
        var normalizedDisplay = NormalizeTokenLocal(displayName);
        var normalizedSession = NormalizeTokenLocal(sessionIdentifier);

        if (normalizedSession.Contains("systemsounds")) return true;
        if (normalizedDisplay == "systemsounds") return true;
        if ((normalizedProcess == "audiodg" || normalizedProcess == "svchost") && pid == 0) return true;
        return false;
    }

    private static string NormalizeTokenLocal(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var lower = value.Trim().ToLowerInvariant();
        if (lower.EndsWith(".exe", StringComparison.Ordinal)) lower = lower[..^4];
        return new string(lower.Where(char.IsLetterOrDigit).ToArray());
    }

    public static string BuildStableSessionToken(string processName, string displayName, string sessionIdentifier)
    {
        var processToken = NormalizeTokenLocal(processName);
        var displayToken = NormalizeTokenLocal(ExtractExecutableCandidate(displayName));
        var sessionToken = NormalizeTokenLocal(ExtractExecutableCandidate(sessionIdentifier));
        var joined = $"{processName} {displayName} {sessionIdentifier}";

        if (Regex.IsMatch(joined, "whatsapp", RegexOptions.IgnoreCase))
        {
            return "whatsapp.exe";
        }

        // For generic host processes (WebView2/UWP hosts), prefer a specific display/session token
        // when available so embedded apps don't collapse under a host executable name.
        if (IsGenericHostProcessToken(processToken))
        {
            if (!string.IsNullOrWhiteSpace(displayToken) && !IsGenericHostProcessToken(displayToken))
            {
                return displayToken + ".exe";
            }
            if (!string.IsNullOrWhiteSpace(sessionToken) && !IsGenericHostProcessToken(sessionToken))
            {
                return sessionToken + ".exe";
            }
        }

        if (!string.IsNullOrWhiteSpace(processToken))
        {
            return processToken + ".exe";
        }

        if (!string.IsNullOrWhiteSpace(displayToken))
        {
            return displayToken + ".exe";
        }

        if (!string.IsNullOrWhiteSpace(sessionToken))
        {
            return sessionToken + ".exe";
        }

        return string.Empty;
    }

    private static bool IsGenericHostProcessToken(string token)
    {
        return token is "msedgewebview2" or "microsoftedgewebview2" or "applicationframehost" or "wwahost";
    }

    private static string ExtractExecutableCandidate(string value)
    {
        var raw = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;

        var appIdx = raw.IndexOf("\\Application\\", StringComparison.OrdinalIgnoreCase);
        if (appIdx >= 0)
        {
            raw = raw[(appIdx + "\\Application\\".Length)..];
        }

        raw = Path.GetFileName(raw.Replace('/', '\\'));
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        var exeIndex = raw.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        if (exeIndex >= 0)
        {
            raw = raw[..(exeIndex + 4)];
        }
        return raw;
    }
}

internal readonly record struct SessionSelector(string Token, bool IsSystem);

internal sealed class AudioSnapshot
{
    public AudioEndpointSnapshot? Speaker { get; set; }
    public AudioEndpointSnapshot? Mic { get; set; }
    public List<AudioEndpointSnapshot> Speakers { get; set; } = new();
    public List<AudioEndpointSnapshot> Mics { get; set; } = new();
    public List<AudioSessionSnapshot> Apps { get; set; } = new();
}

internal sealed class AudioEndpointSnapshot
{
    public string Name { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Id { get; set; } = string.Empty;
    public string EndpointId { get; set; } = string.Empty;
    public bool IsDefault { get; set; }
    public int Volume { get; set; }
    public bool Muted { get; set; }
    public string State { get; set; } = "Unknown";
}

internal sealed class AudioSessionSnapshot
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public int Volume { get; set; }
    public bool Muted { get; set; }
    public string State { get; set; } = "Inactive";
    public uint ProcessId { get; set; }
    public bool IsSystem { get; set; }
}

internal sealed class AudioActivitySnapshot
{
    public int Speaker { get; set; }
    public List<AudioSessionActivitySnapshot> Apps { get; set; } = new();
}

internal sealed class AudioSessionActivitySnapshot
{
    public string Id { get; set; } = string.Empty;
    public uint ProcessId { get; set; }
    public int Activity { get; set; }
}

internal sealed class MediaInfoSnapshot
{
    public bool Active { get; set; }
    public string App { get; set; } = string.Empty;
    public string Source { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Artist { get; set; } = string.Empty;
    public string Album { get; set; } = string.Empty;
    public string PlaybackStatus { get; set; } = "Closed";
    public string? Thumbnail { get; set; }
    public double Position { get; set; }
    public int Duration { get; set; }
    public int Score { get; set; }
    public string? Error { get; set; }

    public static MediaInfoSnapshot Closed()
    {
        return new MediaInfoSnapshot
        {
            Active = false,
            App = string.Empty,
            Source = string.Empty,
            Title = string.Empty,
            Artist = string.Empty,
            Album = string.Empty,
            PlaybackStatus = "Closed",
            Thumbnail = null,
            Position = 0,
            Duration = 0,
            Score = 0,
            Error = null,
        };
    }

    public static MediaInfoSnapshot Unavailable(string error)
    {
        return new MediaInfoSnapshot
        {
            Active = false,
            App = string.Empty,
            Source = string.Empty,
            Title = string.Empty,
            Artist = string.Empty,
            Album = string.Empty,
            PlaybackStatus = "Unavailable",
            Thumbnail = null,
            Position = 0,
            Duration = 0,
            Score = 0,
            Error = string.IsNullOrWhiteSpace(error) ? "Media unavailable" : error,
        };
    }
}

internal sealed class MediaActionResult
{
    public bool Ok { get; set; }
    public double Position { get; set; }
    public int Duration { get; set; }
    public string? Error { get; set; }
}

internal sealed class MediaSessionCandidate
{
    public GlobalSystemMediaTransportControlsSession Session { get; set; } = null!;
    public int Score { get; set; }
    public string Source { get; set; } = string.Empty;
    public string App { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Artist { get; set; } = string.Empty;
    public string Album { get; set; } = string.Empty;
    public string PlaybackStatus { get; set; } = "Unknown";
    public double Position { get; set; }
    public int Duration { get; set; }
    public IRandomAccessStreamReference? ThumbnailRef { get; set; }
}

internal enum EDataFlow
{
    Render = 0,
    Capture = 1,
    All = 2
}

internal enum ERole
{
    Console = 0,
    Multimedia = 1,
    Communications = 2
}

[StructLayout(LayoutKind.Sequential)]
internal struct PROPERTYKEY
{
    public Guid Fmtid;
    public uint Pid;

    public PROPERTYKEY(Guid fmtid, uint pid)
    {
        Fmtid = fmtid;
        Pid = pid;
    }
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    int GetCount(out uint propertyCount);
    int GetAt(uint propertyIndex, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.Struct)] out object value);
    int SetValue(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.Struct)] ref object value);
    int Commit();
}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumeratorComObject
{
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
    int OpenPropertyStore(int stgmAccess, out object properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[ComImport]
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    int GetCount(out uint deviceCount);
    int Item(uint deviceNumber, out IMMDevice device);
}

[ComImport]
[Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
internal class PolicyConfigClientComObject
{
}

[ComImport]
[Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPolicyConfig
{
    int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr format);
    int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultFormat, IntPtr format);
    int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultPeriod, IntPtr defaultPeriodPtr, IntPtr minimumPeriodPtr);
    int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr periodPtr);
    int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr modePtr);
    int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr modePtr);
    int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr propertyKey, IntPtr propertyValue);
    int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr propertyKey, IntPtr propertyValue);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
    int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
}

[ComImport]
[Guid("CA286FC3-91FD-42C3-8E9B-CAAFA66242E3")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPolicyConfigModern
{
    int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr format);
    int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultFormat, IntPtr format);
    int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultPeriod, IntPtr defaultPeriodPtr, IntPtr minimumPeriodPtr);
    int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr periodPtr);
    int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr modePtr);
    int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr modePtr);
    int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr propertyKey, IntPtr propertyValue);
    int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr propertyKey, IntPtr propertyValue);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
    int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
}

[ComImport]
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioEndpointVolume
{
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint channelCount);
    int SetMasterVolumeLevel(float levelDb, Guid eventContext);
    int SetMasterVolumeLevelScalar(float level, Guid eventContext);
    int GetMasterVolumeLevel(out float levelDb);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float levelDb, Guid eventContext);
    int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
    int GetChannelVolumeLevel(uint channel, out float levelDb);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
    int GetMute(out bool mute);
}

[ComImport]
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioMeterInformation
{
    int GetPeakValue(out float peak);
    int GetMeteringChannelCount(out uint channelCount);
    int GetChannelsPeakValues(uint channelCount, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peakValues);
    int QueryHardwareSupport(out int hardwareSupportMask);
}

[ComImport]
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionManager2
{
    int GetAudioSessionControl(ref Guid audioSessionGuid, int streamFlags, out IAudioSessionControl sessionControl);
    int GetSimpleAudioVolume(ref Guid audioSessionGuid, int streamFlags, out ISimpleAudioVolume audioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
    int RegisterSessionNotification(IntPtr sessionNotification);
    int UnregisterSessionNotification(IntPtr sessionNotification);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
    int UnregisterDuckNotification(IntPtr duckNotification);
}

[ComImport]
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionEnumerator
{
    int GetCount(out int sessionCount);
    int GetSession(int sessionIndex, out IAudioSessionControl session);
}

[ComImport]
[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionControl
{
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, Guid eventContext);
    int GetGroupingParam(out Guid groupingId);
    int SetGroupingParam(Guid groupingId, Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
}

[ComImport]
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionControl2
{
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, Guid eventContext);
    int GetGroupingParam(out Guid groupingId);
    int SetGroupingParam(Guid groupingId, Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionInstanceIdentifier);
    int GetProcessId(out uint processId);
    int IsSystemSoundsSession();
    int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[ComImport]
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ISimpleAudioVolume
{
    int SetMasterVolume(float level, Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
    int GetMute(out bool mute);
}
