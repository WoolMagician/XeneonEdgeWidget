using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AudioCtl;

internal static class Program
{
    private const int ClsCtxAll = 23;
    private const int S_OK = 0;

    private static int Main(string[] args)
    {
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
                case "switch-default-render":
                    return SwitchDefaultRenderEndpoint(ParseText(args, 1), ParseText(args, 2));
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

    private static int ApplyToRenderSessions(string sessionId, Action<ISimpleAudioVolume> applyAction)
    {
        var selector = ParseSessionSelector(sessionId);
        var manager = default(IAudioSessionManager2);
        var enumerator = default(IAudioSessionEnumerator);
        var control = default(IAudioSessionControl);
        var control2 = default(IAudioSessionControl2);
        var volume = default(ISimpleAudioVolume);
        var matchCount = 0;

        try
        {
            manager = ActivateDefaultEndpoint<IAudioSessionManager2>(EDataFlow.Render);
            var hr = manager.GetSessionEnumerator(out enumerator);
            if (hr != S_OK || enumerator == null) throw new COMException("GetSessionEnumerator failed", hr);
            hr = enumerator.GetCount(out var count);
            if (hr != S_OK) throw new COMException("GetSessionCount failed", hr);

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
        finally
        {
            ReleaseCom(volume);
            ReleaseCom(control2);
            ReleaseCom(control);
            ReleaseCom(enumerator);
            ReleaseCom(manager);
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
            return session.IsSystemSoundsSession() == S_OK;
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

internal readonly record struct SessionSelector(string Token, bool IsSystem);

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
    int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out object devices);
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
