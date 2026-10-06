using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Munni.Api.Lab;

/// <summary>What the operator asks the scaffold to call the new party.</summary>
public sealed record LabScaffoldRequest(string Provider, string Name, string Product, string Country = "NL");

/// <summary>
/// The new-service scaffold (#441 L5): from a recording, the files an
/// adapter author starts from — a manifest stub, an OBSERVED options class
/// (every host and path the recording saw, as constants with what was
/// observed in their doc comments), an adapter stub with a to-do per observed
/// call, the JSON answers worth reading as redacted fixtures, a test
/// skeleton wired to them, a README that says where to register it, and
/// the digest. Every path is a repo path, so the zip unpacks at the root.
///
/// Nothing here guesses at what a party means by its JSON: the generator
/// names what was seen and leaves the reading to the author. The recording
/// was redacted before it was written, so the fixtures carry `«redacted:n»`
/// where a secret stood - and a scaffold that found an unmasked credential
/// would be a bug in the recorder, not a job for this file.
/// </summary>
public static partial class LabScaffold
{
    public static readonly IReadOnlySet<string> Products = new HashSet<string>(StringComparer.Ordinal) { "shop", "bank", "registry" };

    private const int MaxFixtures = 40;

    private const int MaxObservedPaths = 60;

    private const string DocOpen = "/// <summary>";

    private const string DocClose = "/// </summary>";

    private const string BlockOpen = "    {";

    private const string BlockClose = "    }";

    private static readonly JsonSerializerOptions PrettyOptions = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private static readonly HashSet<string> Noise = new(StringComparer.Ordinal)
    {
        "script", "stylesheet", "image", "font", "media", "manifest", "texttrack", "ping", "beacon", "preflight", "other",
    };

    [GeneratedRegex("[^A-Za-z0-9]+")]
    private static partial Regex NonWord { get; }

    public sealed record ScaffoldFile(string Path, string Content);

    /// <summary>The files, as repo paths with their text.</summary>
    public static IReadOnlyList<ScaffoldFile> Files(LabScaffoldRequest request, JsonObject trace, string digest)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(trace);
        ArgumentNullException.ThrowIfNull(digest);

        var product = Product.Of(request.Product);
        var observed = Observe(trace);
        var files = new List<ScaffoldFile>
        {
            new($"server/src/connectors/{product.Assembly}/{request.Name}/{request.Name}Manifest.cs", Manifest(request, product, observed)),
            new($"server/src/connectors/{product.Assembly}/{request.Name}/{request.Name}Options.cs", Options(request, product, observed)),
            new($"server/src/connectors/{product.Assembly}/{request.Name}/{request.Name}Adapter.cs", Adapter(request, product, observed)),
            new($"server/tests/connectors/{product.Assembly}.Tests/{request.Name}AdapterTests.cs", Tests(request, product, observed)),
            new($"server/src/connectors/{product.Assembly}/Fixtures/{request.Provider}/README.md", FixturesReadme(request, observed)),
            new("README.md", Readme(request, product, observed, trace)),
            new("digest.md", digest),
        };

        files.AddRange(observed.Fixtures.Select(f => new ScaffoldFile($"server/src/connectors/{product.Assembly}/Fixtures/{request.Provider}/{f.File}", f.Body)));
        return files;
    }

    /// <summary>The files as one zip, each at its repo path; small enough to build in memory.</summary>
    public static byte[] Zip(IReadOnlyList<ScaffoldFile> files)
    {
        ArgumentNullException.ThrowIfNull(files);
        using var packed = new MemoryStream();
        using (var archive = new ZipArchive(packed, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var file in files)
            {
                using var stream = archive.CreateEntry(file.Path, CompressionLevel.Optimal).Open();
                var bytes = Encoding.UTF8.GetBytes(file.Content);
                stream.Write(bytes, 0, bytes.Length);
            }
        }

        return packed.ToArray();
    }

    /// <summary>A product's assembly and the record shape its resources return.</summary>
    private sealed record Product(string Assembly, string Kind, string Resource, string Returns, string RegisterIn)
    {
        public static Product Of(string product) => product switch
        {
            "bank" => new("BankConnector.Adapters", "Bank", "transactions", "Transaction", "BankAdapters.Real"),
            "registry" => new("RegistryConnector.Adapters", "Registry", "registrations", "CreditRegistration", "RegistryAdapters.Real"),
            _ => new("ShopConnector.Adapters", "Store", "receipts", "Receipt", "ShopAdapters.Real"),
        };
    }

    private sealed record ObservedCall(string Method, string Url, string Host, string Path, int? Status, string? ContentType, long? Size, string? Body, string Via, string? JsonShape, string OptionName);

    private sealed record ObservedFixture(string File, string Body, ObservedCall Call);

    private sealed record Observation(
        string JobId,
        string Provider,
        string? LoginUrl,
        string? LoginHost,
        string? ApiHost,
        IReadOnlyList<string> Hosts,
        IReadOnlyList<ObservedCall> Calls,
        IReadOnlyList<string> FormFields,
        IReadOnlyList<ObservedFixture> Fixtures,
        bool UsedBrowser,
        int Entries,
        string StartedAt);

    private static Observation Observe(JsonObject trace)
    {
        var entries = trace["entries"] as JsonArray ?? [];
        var loginUrl = entries.Where(e => Text(e, "kind") == "navigation").Select(e => Text(e, "url")).FirstOrDefault(u => u is not null);
        var book = new ObservationBook();
        foreach (var e in entries) book.Take(e);

        var hosts = book.Calls.GroupBy(c => c.Host, StringComparer.Ordinal).OrderByDescending(g => g.Count()).Select(g => g.Key).ToList();
        var apiHost = book.Calls.Where(c => c.JsonShape is not null).GroupBy(c => c.Host, StringComparer.Ordinal).OrderByDescending(g => g.Count()).Select(g => g.Key).FirstOrDefault() ?? hosts.FirstOrDefault();

        return new Observation(
            Text(trace, "job_id") ?? "job",
            Text(trace, "provider") ?? "explore",
            loginUrl,
            HostOf(loginUrl),
            apiHost,
            hosts,
            book.Calls,
            book.FormFields,
            book.Fixtures,
            book.UsedBrowser,
            entries.Count,
            Text(trace, "started_at") ?? string.Empty);
    }

    /// <summary>The calls, the fixtures and the posted fields a recording's entries add up to, taken one entry at a time.</summary>
    private sealed class ObservationBook
    {
        private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

        public List<ObservedCall> Calls { get; } = [];

        public List<ObservedFixture> Fixtures { get; } = [];

        public List<string> FormFields { get; } = [];

        public bool UsedBrowser { get; private set; }

        public void Take(JsonNode? entry)
        {
            var via = Text(entry, "via") ?? "browser";
            if (via == "browser") UsedBrowser = true;
            var kind = Text(entry, "kind");
            if (kind == "request") TakeRequest(entry);
            else if (kind == "response") TakeResponse(entry, via);
        }

        /// <summary>A write's posted field names, each once, in the order first seen.</summary>
        private void TakeRequest(JsonNode? entry)
        {
            if (!IsWrite(Text(entry, "method")) || Text(entry, "body") is not { Length: > 0 } posted) return;
            foreach (var field in FieldNames(Text(entry, "content_type"), posted).Where(f => !FormFields.Contains(f, StringComparer.Ordinal)))
            {
                FormFields.Add(field);
            }
        }

        /// <summary>An answer worth reading: one call per method and path, and a fixture when it was JSON and whole.</summary>
        private void TakeResponse(JsonNode? entry, string via)
        {
            var type = Text(entry, "resource_type");
            if (via == "browser" && type is not null && Noise.Contains(type)) return;
            var url = Text(entry, "url") ?? string.Empty;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;

            var method = (Text(entry, "method") ?? "GET").ToUpperInvariant();
            if (!_seen.Add($"{method} {uri.Host}{uri.AbsolutePath}") || Calls.Count >= MaxObservedPaths) return;

            var contentType = Text(entry, "content_type");
            var body = Text(entry, "body");
            var json = body is { Length: > 0 } && IsJson(contentType) ? body : null;
            var call = new ObservedCall(method, url, uri.Host, uri.AbsolutePath, Int(entry, "status"), contentType, Long(entry, "size"), body, via, json is null ? null : Shape(json), Constant(method, uri.AbsolutePath, Calls.Count + 1));
            Calls.Add(call);

            if (json is not null && Fixtures.Count < MaxFixtures && Text(entry, "body_truncated") != "true")
            {
                Fixtures.Add(new ObservedFixture($"{Fixtures.Count + 1:00}-{Slug(method, uri.AbsolutePath)}.json", Pretty(json), call));
            }
        }
    }

    // ── the files ───────────────────────────────────────────────────────

    private static string Manifest(LabScaffoldRequest r, Product p, Observation o)
    {
        var runtime = o.UsedBrowser ? "ProviderRuntime.BrowserOnce" : "ProviderRuntime.Http";
        var agent = o.UsedBrowser ? "new AgentRequirement { Required = true, Class = AgentClass.Pooled }" : "AgentRequirement.Inline";
        var fields = o.FormFields.Count == 0 ? ["username", "password"] : o.FormFields.Take(6).ToList();
        var sb = new StringBuilder();
        sb.AppendLine("using Connector.Kit.Challenges;");
        sb.AppendLine("using Connector.Kit.Manifests;");
        sb.AppendLine();
        sb.AppendLine($"namespace {p.Assembly}.{r.Name};");
        sb.AppendLine();
        sb.AppendLine(DocOpen);
        sb.AppendLine($"/// {r.Name}: scaffolded by the connector lab from recording {o.JobId} ({o.StartedAt}).");
        sb.AppendLine("/// Every value below is a STUB to confirm against the recording's digest before");
        sb.AppendLine("/// this manifest ships; the registry validates it at boot, so it must stay whole.");
        sb.AppendLine(DocClose);
        sb.AppendLine($"internal static class {r.Name}Manifest");
        sb.AppendLine("{");
        sb.AppendLine("    public const int Version = 1;");
        sb.AppendLine();
        sb.AppendLine("    public static ProviderManifest Build() => new()");
        sb.AppendLine(BlockOpen);
        sb.AppendLine($"        Id = {r.Name}Adapter.ProviderId,");
        sb.AppendLine($"        Name = \"{Escape(r.Name)}\", // TODO: the party's name as people know it");
        sb.AppendLine($"        Kind = ProviderKind.{p.Kind},");
        sb.AppendLine($"        Country = \"{r.Country}\",");
        sb.AppendLine("        ManifestVersion = Version,");
        sb.AppendLine($"        Runtime = {runtime}, // OBSERVED: the recording {(o.UsedBrowser ? "drove a browser" : "used the HTTP client only")}");
        sb.AppendLine($"        Agent = {agent},");
        sb.AppendLine("        UnattendedFetch = false, // TODO: true only when a kept session fetches without a human");
        sb.AppendLine("        SecretCustody = SecretCustody.Client,");
        sb.AppendLine("        Auth = new AuthSpec");
        sb.AppendLine("        {");
        sb.AppendLine("            Flow = AuthFlow.Password, // TODO: the flow the digest shows (a code? an app approval? the live browser?)");
        sb.AppendLine("            Steps =");
        sb.AppendLine("            [");
        sb.AppendLine("                new AuthStep");
        sb.AppendLine("                {");
        sb.AppendLine("                    Id = \"credentials\",");
        sb.AppendLine("                    Fields =");
        sb.AppendLine("                    [");
        foreach (var field in fields)
        {
            var secret = IsSecretField(field);
            sb.AppendLine("                        new FieldSpec");
            sb.AppendLine("                        {");
            sb.AppendLine($"                            Key = \"{Escape(field)}\", // OBSERVED: a field the recording posted");
            sb.AppendLine($"                            Type = FieldType.{(secret ? "Password" : "Text")},");
            sb.AppendLine($"                            Secret = {(secret ? "true" : "false")},");
            sb.AppendLine("                        },");
        }

        sb.AppendLine("                    ],");
        sb.AppendLine("                },");
        sb.AppendLine("            ],");
        sb.AppendLine("            Challenges = [], // TODO: ChallengeType.MfaCode, Image, AppApproval, LiveView … as the digest shows");
        sb.AppendLine("            Session = new SessionSpec { TtlSeconds = 2_592_000, Refreshable = false, RotatesOnUse = true }, // TODO");
        if (o.LoginHost is not null) sb.AppendLine($"            LoginOrigins = [\"{Escape(o.LoginHost)}\"], // OBSERVED: the first page the recording opened");
        sb.AppendLine("        },");
        sb.AppendLine("        Resources =");
        sb.AppendLine("        [");
        sb.AppendLine("            new ResourceSpec");
        sb.AppendLine("            {");
        sb.AppendLine($"                Id = {r.Name}Adapter.{Pascal(p.Resource)}Resource,");
        sb.AppendLine($"                Returns = ResourceShape.{p.Returns},");
        sb.AppendLine("                Params = [new ParamSpec { Key = \"since\", Type = ParamType.Date }],");
        sb.AppendLine("            },");
        sb.AppendLine("        ],");
        sb.AppendLine("        Limits = new ProviderLimits { MinIntervalSeconds = 21_600, Concurrency = 1 }, // TODO: what the party tolerates");
        sb.AppendLine("    };");
        sb.AppendLine("}");
        return sb.ToString();
    }

    private static string Options(LabScaffoldRequest r, Product p, Observation o)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"namespace {p.Assembly}.{r.Name};");
        sb.AppendLine();
        sb.AppendLine(DocOpen);
        sb.AppendLine($"/// Everything about {r.Name} an operator may need to correct without a release.");
        sb.AppendLine("///");
        sb.AppendLine($"/// OBSERVED from recording {o.JobId} ({o.StartedAt}) in the connector lab: the");
        sb.AppendLine("/// hosts and paths below are what the browser and the HTTP client actually");
        sb.AppendLine("/// called. Nothing here is CONFIRMED until an adapter has run against it and a");
        sb.AppendLine("/// test has pinned the answer - rename the comment when that happens.");
        sb.AppendLine(DocClose);
        sb.AppendLine($"public sealed record {r.Name}Options");
        sb.AppendLine("{");
        if (o.LoginUrl is not null) sb.AppendLine($"    /// <summary>OBSERVED: the first page the recording opened.</summary>{Environment.NewLine}    public string LoginUrl {{ get; init; }} = \"{Escape(o.LoginUrl)}\";{Environment.NewLine}");
        if (o.ApiHost is not null) sb.AppendLine($"    /// <summary>OBSERVED: the host that answered most of the JSON.</summary>{Environment.NewLine}    public string BaseUrl {{ get; init; }} = \"https://{Escape(o.ApiHost)}\";{Environment.NewLine}");
        foreach (var call in o.Calls)
        {
            sb.AppendLine("    /// <summary>");
            sb.Append("    /// OBSERVED: ").Append(call.Method).Append(' ').Append(Escape(call.Host)).Append(Escape(call.Path)).Append(" → ").Append(call.Status?.ToString(CultureInfo.InvariantCulture) ?? "?");
            if (call.ContentType is not null) sb.Append(' ').Append(Escape(Media(call.ContentType)));
            if (call.Size is { } size) sb.Append(' ').Append(size.ToString(CultureInfo.InvariantCulture)).Append(" B");
            sb.AppendLine(call.Via == "http" ? " (http client)" : string.Empty);
            if (call.JsonShape is not null) sb.Append("    /// shape: ").AppendLine(Escape(call.JsonShape));
            sb.AppendLine("    /// </summary>");
            sb.AppendLine($"    public string {call.OptionName} {{ get; init; }} = \"{Escape(call.Path)}\";");
            sb.AppendLine();
        }

        if (o.Calls.Count == 0) sb.AppendLine("    // the recording held no call worth reading; explore further and scaffold again");
        sb.AppendLine("}");
        return sb.ToString();
    }

    private static string Adapter(LabScaffoldRequest r, Product p, Observation o)
    {
        var resource = Pascal(p.Resource) + "Resource";
        var sb = new StringBuilder();
        sb.AppendLine("using Connector.Kit.Adapters;");
        sb.AppendLine("using Connector.Kit.Errors;");
        sb.AppendLine("using Connector.Kit.Jobs;");
        sb.AppendLine("using Connector.Kit.Manifests;");
        sb.AppendLine();
        sb.AppendLine($"namespace {p.Assembly}.{r.Name};");
        sb.AppendLine();
        sb.AppendLine(DocOpen);
        sb.AppendLine($"/// {r.Name}: scaffolded by the connector lab from recording {o.JobId}. Every");
        sb.AppendLine("/// method below is a TODO that names the call the recording saw; read");
        sb.AppendLine("/// digest.md beside this file for the order they came in and the shape of");
        sb.AppendLine("/// each answer. Until it is written, the adapter refuses honestly.");
        sb.AppendLine(DocClose);
        sb.AppendLine($"public sealed class {r.Name}Adapter({r.Name}Options? options = null, TimeProvider? time = null) : IProviderAdapter");
        sb.AppendLine("{");
        sb.AppendLine($"    public const string ProviderId = \"{Escape(r.Provider)}\";");
        sb.AppendLine();
        sb.AppendLine($"    public const string {resource} = \"{p.Resource}\";");
        sb.AppendLine();
        sb.AppendLine($"    private readonly {r.Name}Options _options = options ?? new {r.Name}Options();");
        sb.AppendLine();
        sb.AppendLine("    private readonly TimeProvider _time = time ?? TimeProvider.System;");
        sb.AppendLine();
        sb.AppendLine($"    private static readonly ProviderManifest Manifest = {r.Name}Manifest.Build();");
        sb.AppendLine();
        sb.AppendLine("    public ProviderManifest Describe() => Manifest;");
        sb.AppendLine();
        sb.AppendLine("    public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)");
        sb.AppendLine(BlockOpen);
        sb.AppendLine("        ArgumentNullException.ThrowIfNull(ctx);");
        sb.AppendLine("        // TODO: the sign-in the recording made.");
        foreach (var call in o.Calls.Where(c => IsWrite(c.Method)).Take(5))
        {
            sb.AppendLine($"        //   {call.Method} {call.Host}{call.Path} → {call.Status?.ToString(CultureInfo.InvariantCulture) ?? "?"} (_options.{call.OptionName})");
        }

        sb.AppendLine($"        // The fields the manifest declares arrive as ctx.Inputs[\"…\"]; the session to keep goes into LoginResult.Material.");
        sb.AppendLine($"        throw ConnectorException.Unsupported($\"{{ProviderId}}: the sign-in is not written yet (scaffolded from recording {o.JobId})\");");
        sb.AppendLine(BlockClose);
        sb.AppendLine();
        sb.AppendLine("    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)");
        sb.AppendLine(BlockOpen);
        sb.AppendLine("        ArgumentNullException.ThrowIfNull(ctx);");
        sb.AppendLine("        ArgumentNullException.ThrowIfNull(request);");
        sb.AppendLine($"        // TODO: the calls that carry {p.Resource} - each answer's shape is in the options' comments and its fixture beside the tests.");
        foreach (var call in o.Calls.Where(c => c.JsonShape is not null).Take(8))
        {
            sb.AppendLine($"        //   {call.Method} {call.Host}{call.Path} → {call.Status?.ToString(CultureInfo.InvariantCulture) ?? "?"} (_options.{call.OptionName}): {call.JsonShape}");
        }

        sb.AppendLine($"        throw ConnectorException.Unsupported($\"{{ProviderId}}: {p.Resource} are not read yet (scaffolded from recording {o.JobId})\");");
        sb.AppendLine(BlockClose);
        sb.AppendLine("}");
        return sb.ToString();
    }

    private static string Tests(LabScaffoldRequest r, Product p, Observation o)
    {
        var sb = new StringBuilder();
        sb.AppendLine("using System.Net;");
        sb.AppendLine($"using {p.Assembly}.{r.Name};");
        sb.AppendLine($"using {p.Assembly}.Tests.Support;");
        sb.AppendLine("using Xunit;");
        sb.AppendLine();
        sb.AppendLine($"namespace {p.Assembly}.Tests;");
        sb.AppendLine();
        sb.AppendLine(DocOpen);
        sb.AppendLine($"/// {r.Name}: scaffolded by the connector lab from recording {o.JobId}. One skipped");
        sb.AppendLine("/// test per answer the recording kept as a fixture - unskip each as the adapter");
        sb.AppendLine("/// learns to read it.");
        sb.AppendLine(DocClose);
        sb.AppendLine($"public sealed class {r.Name}AdapterTests");
        sb.AppendLine("{");
        sb.AppendLine($"    private static readonly {r.Name}Options Options = new();");
        sb.AppendLine();
        sb.AppendLine("    [Fact]");
        sb.AppendLine("    public void The_manifest_validates_and_names_its_resource()");
        sb.AppendLine(BlockOpen);
        sb.AppendLine($"        var manifest = new {r.Name}Adapter(Options).Describe();");
        sb.AppendLine("        Connector.Kit.Manifests.ManifestValidator.Validate(manifest);");
        sb.AppendLine($"        Assert.Equal({r.Name}Adapter.ProviderId, manifest.Id);");
        sb.AppendLine($"        Assert.NotNull(manifest.Resource({r.Name}Adapter.{Pascal(p.Resource)}Resource));");
        sb.AppendLine(BlockClose);
        foreach (var fixture in o.Fixtures)
        {
            sb.AppendLine();
            sb.AppendLine($"    [Fact(Skip = \"scaffolded from recording {o.JobId}: write the reader for {fixture.Call.Method} {Escape(fixture.Call.Path)} first\")]");
            sb.AppendLine($"    public void {TestName(fixture.Call)}()");
            sb.AppendLine(BlockOpen);
            sb.AppendLine($"        using var answer = Stub.Fixture(\"{Escape(r.Provider)}/{fixture.File}\", HttpStatusCode.{StatusName(fixture.Call.Status)});");
            sb.AppendLine($"        // OBSERVED shape: {Escape(fixture.Call.JsonShape ?? "?")}");
            sb.AppendLine("        Assert.NotNull(answer.Content);");
            sb.AppendLine(BlockClose);
        }

        sb.AppendLine("}");
        return sb.ToString();
    }

    private static string FixturesReadme(LabScaffoldRequest r, Observation o)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {r.Provider} fixtures");
        sb.AppendLine();
        sb.AppendLine($"Redacted JSON answers from recording {o.JobId} ({o.StartedAt}), one file per call the lab kept. Secrets were taken out before");
        sb.AppendLine("the recording was written (`«redacted:n»` stands where a value was); read each file once more before it ships, and trim what a");
        sb.AppendLine("test does not need. Fixtures ship embedded (see the project file's `EmbeddedResource` glob).");
        sb.AppendLine();
        foreach (var fixture in o.Fixtures)
        {
            sb.Append("- `").Append(fixture.File).Append("` — ").Append(fixture.Call.Method).Append(' ').Append(fixture.Call.Host).Append(fixture.Call.Path)
                .Append(" → ").Append(fixture.Call.Status?.ToString(CultureInfo.InvariantCulture) ?? "?").Append("; shape `").Append(fixture.Call.JsonShape ?? "?").AppendLine("`");
        }

        if (o.Fixtures.Count == 0) sb.AppendLine("The recording held no JSON answer worth keeping.");
        return sb.ToString();
    }

    private static string Readme(LabScaffoldRequest r, Product p, Observation o, JsonObject trace)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {r.Name} — scaffolded by the connector lab");
        sb.AppendLine();
        sb.AppendLine($"From recording `{o.JobId}` of `{o.Provider}` ({o.StartedAt}; {o.Entries} entries, {o.Calls.Count} calls worth reading, {o.Fixtures.Count} fixtures). Unpack this zip at the repository root; every path is where the file belongs.");
        sb.AppendLine();
        sb.AppendLine("## What is here");
        sb.AppendLine();
        sb.AppendLine($"- `server/src/connectors/{p.Assembly}/{r.Name}/{r.Name}Manifest.cs` — the manifest stub: id, kind, country, runtime and agent as observed, the fields the recording posted, one resource (`{p.Resource}`); every TODO is a promise to confirm.");
        sb.AppendLine($"- `server/src/connectors/{p.Assembly}/{r.Name}/{r.Name}Options.cs` — the OBSERVED options: the first page, the host that answered the JSON, and a constant per call with what was observed in its comment.");
        sb.AppendLine($"- `server/src/connectors/{p.Assembly}/{r.Name}/{r.Name}Adapter.cs` — the adapter stub: a TODO per observed call; it refuses honestly until written.");
        sb.AppendLine($"- `server/src/connectors/{p.Assembly}/Fixtures/{r.Provider}/` — the redacted JSON answers and a README naming each.");
        sb.AppendLine($"- `server/tests/connectors/{p.Assembly}.Tests/{r.Name}AdapterTests.cs` — the test skeleton: the manifest validates; one skipped test per fixture.");
        sb.AppendLine("- `digest.md` — the recording's digest: pages, calls by host with the shape of every JSON answer, forms by field name, the jar, the console.");
        sb.AppendLine();
        sb.AppendLine("## Where to register it");
        sb.AppendLine();
        sb.AppendLine($"Add `new {r.Name}Adapter(settings.{r.Name}, time)` to `{p.RegisterIn}` in `server/src/connectors/{p.Assembly}/{p.Assembly.Replace("Connector.Adapters", "Adapters", StringComparison.Ordinal)}.cs` and a `{r.Name}` entry on its options record; the registry validates the manifest at boot, so the whole stub must hold together before the control plane starts. Both products' Program.cs pick the adapter up from there.");
        sb.AppendLine();
        sb.AppendLine("## What the recording saw");
        sb.AppendLine();
        sb.AppendLine($"- First page: `{o.LoginUrl ?? "(none)"}`");
        sb.AppendLine($"- Hosts: {(o.Hosts.Count == 0 ? "(none)" : string.Join(", ", o.Hosts.Select(h => $"`{h}`")))}");
        sb.AppendLine($"- Fields posted: {(o.FormFields.Count == 0 ? "(none)" : string.Join(", ", o.FormFields.Select(f => $"`{f}`")))}");
        sb.AppendLine($"- Cookies at the end: {(trace["cookies"] as JsonArray)?.Count ?? 0}");
        sb.AppendLine();
        sb.AppendLine("Nothing in a scaffold is CONFIRMED. The recording says what a browser did once, on one account, on one day; an adapter says what the party promises. Write the second from the first, then pin it with the tests.");
        return sb.ToString();
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private static string? Text(JsonNode? node, string key) => node?[key] switch
    {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v => v.ToJsonString().Trim('"'),
        _ => null,
    };

    private static int? Int(JsonNode? node, string key) => node?[key] is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;

    private static long? Long(JsonNode? node, string key) => node?[key] is JsonValue v && v.TryGetValue<long>(out var l) ? l : null;

    private static string? HostOf(string? url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : null;

    private static bool IsWrite(string? method) => method is not null && method.ToUpperInvariant() is "POST" or "PUT" or "PATCH" or "DELETE";

    private static bool IsJson(string? contentType) =>
        contentType is not null && (Media(contentType).EndsWith("/json", StringComparison.Ordinal) || Media(contentType).EndsWith("+json", StringComparison.Ordinal));

    private static string Media(string contentType)
    {
        var semicolon = contentType.IndexOf(';', StringComparison.Ordinal);
        return (semicolon < 0 ? contentType : contentType[..semicolon]).Trim();
    }

    private static bool IsSecretField(string field) =>
        field.Contains("pass", StringComparison.OrdinalIgnoreCase) || field.Contains("pin", StringComparison.OrdinalIgnoreCase)
        || field.Contains("secret", StringComparison.OrdinalIgnoreCase) || field.Contains("otp", StringComparison.OrdinalIgnoreCase)
        || field.Contains("code", StringComparison.OrdinalIgnoreCase);

    private static List<string> FieldNames(string? contentType, string body)
    {
        if (IsJson(contentType) || body.AsSpan().TrimStart() is ['{', ..])
        {
            try
            {
                if (JsonNode.Parse(body) is JsonObject obj) return obj.Select(p => p.Key).Take(24).ToList();
            }
            catch (JsonException)
            {
                // a form, then
            }
        }

        return body.Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => Uri.UnescapeDataString(p.Split('=')[0].Replace('+', ' ')))
            .Where(k => k.Length is > 0 and <= 64 && !k.Contains('\n', StringComparison.Ordinal))
            .Take(24)
            .ToList();
    }

    private static string Constant(string method, string path, int ordinal)
    {
        var words = NonWord.Split(path).Where(w => w.Length > 0).Select(Pascal).ToList();
        var name = (method == "GET" ? string.Empty : Pascal(method.ToLowerInvariant())) + string.Concat(words) + "Path";
        if (name.Length > 60) name = name[..60] + "Path";
        return char.IsDigit(name[0]) ? $"Call{ordinal}{name}" : name;
    }

    private static string Slug(string method, string path)
    {
        var slug = NonWord.Replace($"{method} {path}".ToLowerInvariant(), "-").Trim('-');
        return slug.Length > 60 ? slug[..60].TrimEnd('-') : slug;
    }

    private static string TestName(ObservedCall call) => $"Reads_{Slug(call.Method, call.Path).Replace('-', '_')}";

    private static string StatusName(int? status) => status switch
    {
        null or 200 => "OK",
        201 => "Created",
        204 => "NoContent",
        302 => "Found",
        400 => "BadRequest",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "NotFound",
        _ => "OK",
    };

    private static string Pascal(string word) => word.Length == 0 ? word : char.ToUpperInvariant(word[0]) + word[1..];

    private static string Escape(string text) => text.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

    private static string Pretty(string json)
    {
        try
        {
            return JsonSerializer.Serialize(JsonNode.Parse(json), PrettyOptions);
        }
        catch (JsonException)
        {
            return json;
        }
    }

    /// <summary>The first element's shape, "…" past the third level, "?" for an empty array.</summary>
    private static string ElementShape(JsonArray array, int depth)
    {
        if (array.FirstOrDefault(a => a is not null) is not { } first) return "?";
        return depth >= 3 ? "…" : Shape(first, depth + 1);
    }

    /// <summary>Keys and types, never values, three levels deep.</summary>
    private static string Shape(string json)
    {
        try
        {
            var node = JsonNode.Parse(json);
            return node is null ? "null" : Shape(node, 0);
        }
        catch (JsonException)
        {
            return "(not JSON)";
        }
    }

    private static string Shape(JsonNode node, int depth) => node switch
    {
        JsonObject when depth >= 3 => "{…}",
        JsonObject obj => "{" + string.Join(", ", obj.Take(12).Select(p => p.Value is null ? $"{p.Key}: null" : $"{p.Key}: {Shape(p.Value, depth + 1)}")) + (obj.Count > 12 ? $", … {obj.Count - 12} more" : string.Empty) + "}",
        JsonArray array => $"[{array.Count.ToString(CultureInfo.InvariantCulture)} × {ElementShape(array, depth)}]",
        JsonValue value => value.GetValueKind() switch
        {
            JsonValueKind.String => "string",
            JsonValueKind.Number => "number",
            JsonValueKind.True or JsonValueKind.False => "bool",
            JsonValueKind.Null => "null",
            _ => "value",
        },
        _ => "null",
    };
}
