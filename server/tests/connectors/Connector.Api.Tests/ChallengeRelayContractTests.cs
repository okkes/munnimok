using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// a challenge crosses four hand-copied records and a dropped field fails silently (AnswerKind stopped at the adapter
/// boundary: browser-tier captchas were relayed as text boxes);
/// this project alone sees both what the agent SENDS and the server BINDS
[Collection(ShopApiCollection.Name)]
public sealed class ChallengeRelayContractTests(ShopApiFactory factory)
{
    private const string Provider = "mock-store";

    private const string SessionId = "ses_0123456789abcdef0123456789abcdef";

    private const string ChallengeId = "chl_0123456789abcdef0123456789abcdef";

    /// <summary>PNG's magic number. A tap challenge without a picture is not answerable.</summary>
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    /// Challenge fields deliberately absent from ChallengePayload, each with a reason:
    /// weakening the check instead of adding an entry loses fields
    private static readonly Dictionary<string, string> ChallengeFieldsNotInThePayload = new(StringComparer.Ordinal)
    {
        ["Type"] = "a column of its own on ChallengeRow, and its own field on ChallengeView",
        ["ExpiresAt"] = "a column of its own on ChallengeRow, and its own field on ChallengeView",
        ["Image"] = "bytes: stored in ChallengeRow.ImageBytes and served from an authenticated "
                    + "URL, never inside the JSON and never in a webhook",
        ["Crop"] = "agent-only. The region the screenshot was cut from exists to map the human's "
                   + "taps back to page pixels; it never leaves the machine driving the browser",
    };

    /// RaiseChallengeRequest fields with no AgentChallengeRequest counterpart; stays empty:
    /// a sent-but-unbound field is dropped without a trace
    private static readonly Dictionary<string, string> SentButNeverBound = new(StringComparer.Ordinal);

    /// fields the server binds that no agent can send; stays empty: such a field is always default in production
    private static readonly Dictionary<string, string> BoundButNeverSent = new(StringComparer.Ordinal);

    /// two hand-synced records describe one wire shape; only this test keeps them in step
    [Fact]
    public void The_record_the_agent_sends_and_the_record_the_server_binds_expose_the_same_fields()
    {
        var sent = FieldsOf(typeof(RaiseChallengeRequest));
        var bound = FieldsOf(typeof(AgentChallengeRequest));
        var problems = new List<string>();

        foreach (var (name, field) in Ordered(sent))
        {
            if (bound.ContainsKey(name) || SentButNeverBound.ContainsKey(name)) continue;

            problems.Add(
                $"'{name}' ({Describe(field)}) is SENT by the agent and never BOUND by the server."
                + $"\n      Every agent that sets it has it dropped on arrival, silently, with"
                + $"\n      no failure anywhere and every test still green."
                + $"\n      Fix: add the property to AgentChallengeRequest in"
                + $"\n      connector-kit/src/Connector.Kit.Hosting/Endpoints/Wire.cs, and copy it into"
                + $"\n      the ChallengePayload built by AgentApiEndpoints.Map - the record alone does"
                + $"\n      nothing. If it really is agent-only transport, add it to the"
                + $"\n      SentButNeverBound allow-list in this file, with the reason.");
        }

        foreach (var (name, field) in Ordered(bound))
        {
            if (sent.ContainsKey(name) || BoundButNeverSent.ContainsKey(name)) continue;

            problems.Add(
                $"'{name}' ({Describe(field)}) is BOUND by the server and no agent can SEND it."
                + $"\n      It will hold its default value for every challenge ever raised in"
                + $"\n      production, while a test that constructs AgentChallengeRequest by hand"
                + $"\n      makes the feature look finished."
                + $"\n      Fix: add the property to RaiseChallengeRequest in"
                + $"\n      connector-kit/src/Connector.Kit/AgentProtocol/AgentContracts.cs and populate"
                + $"\n      it in AgentJobContext.AskAsync - or add it to the BoundButNeverSent"
                + $"\n      allow-list in this file, with the reason.");
        }

        foreach (var (name, field) in Ordered(sent))
        {
            if (!bound.TryGetValue(name, out var other)) continue;
            if (field.Type == other.Type && field.Nullable == other.Nullable) continue;

            problems.Add(
                $"'{name}' is {Describe(field)} on RaiseChallengeRequest but {Describe(other)} on"
                + $"\n      AgentChallengeRequest. One wire shape cannot have two types: whichever end"
                + $"\n      is wrong will read a value the other never meant to send.");
        }

        Assert.True(problems.Count == 0, Report(
            "RaiseChallengeRequest (Connector.Kit/AgentProtocol/AgentContracts.cs - what the AGENT SENDS)",
            "AgentChallengeRequest (Connector.Kit.Hosting/Endpoints/Wire.cs - what the SERVER BINDS)",
            problems));
    }

    /// agreeing on C# names is not agreeing on the wire:
    /// explicit JsonPropertyNames versus the naming policy must give the same string
    [Fact]
    public void The_two_records_agree_on_every_wire_name_and_on_which_fields_are_required()
    {
        var sent = WireFieldsOf(typeof(RaiseChallengeRequest));
        var bound = WireFieldsOf(typeof(AgentChallengeRequest));
        var problems = new List<string>();

        foreach (var (name, field) in sent.OrderBy(f => f.Key, StringComparer.Ordinal))
        {
            if (!bound.TryGetValue(name, out var other)) continue;

            if (!string.Equals(field.WireName, other.WireName, StringComparison.Ordinal))
            {
                problems.Add(
                    $"'{name}' goes out as '{field.WireName}' and is read back as '{other.WireName}'."
                    + $"\n      The value is dropped on arrival: System.Text.Json has no property to"
                    + $"\n      bind '{field.WireName}' to, and says nothing about it.");
            }

            if (field.Required != other.Required)
            {
                problems.Add(
                    $"'{name}' is {(field.Required ? "required" : "optional")} on the agent's record and"
                    + $"\n      {(other.Required ? "required" : "optional")} on the server's."
                    + (other.Required
                        ? "\n      Every raise that omits it is a 400 the agent cannot explain."
                        : "\n      The server will accept a body the agent's own record forbids."));
            }
        }

        Assert.True(problems.Count == 0, Report(
            "RaiseChallengeRequest, serialised by the agent with ConnectorWireJson.Options",
            "AgentChallengeRequest, bound by the server from the same body",
            problems));
    }

    /// everything an adapter can raise must reach the consumer's record or be named in ChallengeFieldsNotInThePayload
    [Fact]
    public void Every_field_an_adapter_can_raise_reaches_the_consumer_or_is_listed_with_a_reason()
    {
        var raised = FieldsOf(typeof(Challenge));
        var payload = FieldsOf(typeof(ChallengePayload));
        var problems = new List<string>();

        foreach (var (name, field) in Ordered(raised))
        {
            if (payload.ContainsKey(name) || ChallengeFieldsNotInThePayload.ContainsKey(name)) continue;

            problems.Add(
                $"'{name}' ({Describe(field)}) is on Challenge - an adapter can set it - and there is"
                + $"\n      nowhere for it to go. ChallengePayload is the ONLY thing a consumer sees,"
                + $"\n      so a field missing here is a field no human is ever shown, with no error"
                + $"\n      and no failing test."
                + $"\n      Fix: add it to ChallengePayload and to ChallengePayload.From in"
                + $"\n      connector-kit/src/Connector.Kit.Hosting/Challenges/ChallengeService.cs - or add"
                + $"\n      it to the ChallengeFieldsNotInThePayload allow-list here, with the reason.");
        }

        Assert.True(problems.Count == 0, Report(
            "Challenge (what an adapter raises)",
            "ChallengePayload (the only part of it a consumer ever sees)",
            problems));
    }

    /// a payload field with no wire field is inline-only; one with no view field is stored and never read
    [Fact]
    public void Every_consumer_visible_field_exists_on_the_view_and_on_both_agent_records()
    {
        var payload = FieldsOf(typeof(ChallengePayload));
        var view = FieldsOf(typeof(ChallengeView));
        var sent = FieldsOf(typeof(RaiseChallengeRequest));
        var bound = FieldsOf(typeof(AgentChallengeRequest));
        var problems = new List<string>();

        foreach (var (name, field) in Ordered(payload))
        {
            if (!view.ContainsKey(name))
            {
                problems.Add(
                    $"'{name}' ({Describe(field)}) is stored in the payload and has no field on"
                    + $"\n      ChallengeView, so it is written to the database and never served."
                    + $"\n      Fix: add it to ChallengeView and to ChallengeView.From"
                    + $"\n      (connector-kit/src/Connector.Kit.Hosting/Endpoints/Wire.cs).");
            }

            var missing = new List<string>();
            if (!sent.ContainsKey(name)) missing.Add("RaiseChallengeRequest");
            if (!bound.ContainsKey(name)) missing.Add("AgentChallengeRequest");

            if (missing.Count > 0)
            {
                problems.Add(
                    $"'{name}' ({Describe(field)}) is consumer-visible but is missing from"
                    + $"\n      {string.Join(" and ", missing)}, so only an INLINE adapter can ever set it."
                    + $"\n      Browser-tier providers - the only ones that ever show a captcha - would"
                    + $"\n      reach the consumer without it, which is how AnswerKind came to be inert.");
            }
        }

        Assert.True(problems.Count == 0, Report(
            "ChallengePayload (what the consumer sees)",
            "ChallengeView, RaiseChallengeRequest and AgentChallengeRequest (how it gets there)",
            problems));
    }

    [Fact]
    public void A_tap_challenge_raised_inline_reaches_the_consumer_as_taps()
    {
        var challenge = new Challenge
        {
            Type = ChallengeType.Image,
            AnswerKind = ChallengeAnswerKind.Taps,
            PromptKey = "connect.challenge.captcha",
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5),
            Image = Png,
            Crop = new CropRegion(0, 0, 400, 400),
        };

        var payload = ChallengePayload.From(challenge);
        Assert.Equal(ChallengeAnswerKind.Taps, payload.AnswerKind);

        var row = Row(ConnectorJson.Serialize(payload), Png);
        var view = ChallengeView.From(row, Provider, SessionId);

        Assert.Equal(ChallengeAnswerKind.Taps, view.AnswerKind);

        Assert.Equal("connect.challenge.captcha", view.PromptKey);
        Assert.Equal($"/v1/{Provider}/login/{SessionId}/challenges/{ChallengeId}/image", view.ImageUrl);
    }

    /// the agent's record is serialised with the agent's options and bound with the server's,
    /// crossed as the real POST crosses them; a round trip through one set moves both ends together
    /// (the bug on ConnectorWireJson)
    [Fact]
    public void A_tap_challenge_raised_by_an_agent_survives_the_wire_and_reaches_the_consumer_as_taps()
    {
        var written = JsonSerializer.Serialize(FullyPopulatedRaise(), ConnectorWireJson.Options);

        var bound = JsonSerializer.Deserialize<AgentChallengeRequest>(written, ConnectorJson.Options);
        Assert.NotNull(bound);
        Assert.Equal(ChallengeAnswerKind.Taps, bound.AnswerKind);

        // a field the server does not bind vanishes from this string
        Assert.Equal(
            Canonical(written),
            Canonical(JsonSerializer.Serialize(bound, ConnectorWireJson.Options)));

        var payload = new ChallengePayload
        {
            AnswerKind = bound.AnswerKind,
            PromptKey = bound.PromptKey,
            Code = bound.Code,
            Delivery = bound.Delivery,
            Length = bound.Length,
            Options = bound.Options,
            Url = bound.Url,
            ReturnPattern = bound.ReturnPattern,
        };

        var view = ChallengeView.From(Row(ConnectorJson.Serialize(payload), Png), Provider, SessionId);

        Assert.Equal(ChallengeAnswerKind.Taps, view.AnswerKind);
        Assert.Equal("connect.challenge.captcha", view.PromptKey);
        Assert.Equal("appie://login-exit*", view.ReturnPattern);
    }

    /// ConfigureHttpJsonOptions copies the naming policy and converters from ConnectorJson by hand:
    /// a third definition, caught only by asking the host
    [Fact]
    public void The_running_host_binds_an_agents_challenge_body_with_the_same_encoding()
    {
        var written = JsonSerializer.Serialize(FullyPopulatedRaise(), ConnectorWireJson.Options);

        var binder = factory.Services
            .GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>()
            .Value.SerializerOptions;

        var bound = JsonSerializer.Deserialize<AgentChallengeRequest>(written, binder);

        Assert.NotNull(bound);
        Assert.Equal(ChallengeAnswerKind.Taps, bound.AnswerKind);
        Assert.Equal(
            Canonical(written),
            Canonical(JsonSerializer.Serialize(bound, ConnectorWireJson.Options)));
    }

    /// Text is first in the enum and therefore the default, which is why the field could be added to a live wire
    [Fact]
    public void A_challenge_without_an_answer_kind_still_means_text_everywhere()
    {
        const string legacyPayload = """{"prompt_key":"connect.challenge.mfa","delivery":"sms","length":6}""";
        const string legacyBody =
            """{"type":"mfa_code","expires_at":"2026-07-28T12:00:00+00:00","prompt_key":"connect.challenge.mfa"}""";

        // A payload column written before the field existed.
        var payload = ConnectorJson.DeserializeOr(legacyPayload, new ChallengePayload());
        Assert.Equal(ChallengeAnswerKind.Text, payload.AnswerKind);
        Assert.Equal("connect.challenge.mfa", payload.PromptKey);

        var view = ChallengeView.From(Row(legacyPayload), Provider, SessionId);
        Assert.Equal(ChallengeAnswerKind.Text, view.AnswerKind);
        Assert.Equal("connect.challenge.mfa", view.PromptKey);

        // An empty column - the ChallengeRow default - is not a crash either.
        Assert.Equal(ChallengeAnswerKind.Text, ChallengeView.From(Row("{}"), Provider, SessionId).AnswerKind);

        // A body from an agent that predates the field, read by both records.
        var sent = JsonSerializer.Deserialize<RaiseChallengeRequest>(legacyBody, ConnectorWireJson.Options);
        var bound = JsonSerializer.Deserialize<AgentChallengeRequest>(legacyBody, ConnectorJson.Options);

        Assert.NotNull(sent);
        Assert.NotNull(bound);
        Assert.Equal(ChallengeAnswerKind.Text, sent.AnswerKind);
        Assert.Equal(ChallengeAnswerKind.Text, bound.AnswerKind);
        Assert.Equal("connect.challenge.mfa", bound.PromptKey);

        // the default is the same in C# as on the wire, so an adapter that never heard of taps is safe
        Assert.Equal(ChallengeAnswerKind.Text, new ChallengePayload().AnswerKind);
        Assert.Equal(
            ChallengeAnswerKind.Text,
            new Challenge { Type = ChallengeType.MfaCode, ExpiresAt = DateTimeOffset.UtcNow }.AnswerKind);
    }

    /// a consumer codes against the JSON, not the record: a C# round trip agreeing with itself says nothing about the wire
    [Fact]
    public void The_wire_spells_the_field_answer_kind_and_the_value_taps()
    {
        var expires = DateTimeOffset.UtcNow.AddMinutes(5);

        AssertAnswerKind(JsonSerializer.Serialize(
            new RaiseChallengeRequest
            {
                Type = ChallengeType.Image,
                AnswerKind = ChallengeAnswerKind.Taps,
                ExpiresAt = expires,
            },
            ConnectorWireJson.Options));

        AssertAnswerKind(JsonSerializer.Serialize(
            new AgentChallengeRequest
            {
                Type = ChallengeType.Image,
                AnswerKind = ChallengeAnswerKind.Taps,
                ExpiresAt = expires,
            },
            ConnectorWireJson.Options));

        AssertAnswerKind(ConnectorJson.Serialize(
            new ChallengePayload { AnswerKind = ChallengeAnswerKind.Taps }));

        // ConnectorResults.Json writes every response with these options
        AssertAnswerKind(ConnectorJson.Serialize(new ChallengeView
        {
            Id = ChallengeId,
            Type = ChallengeType.Image,
            AnswerKind = ChallengeAnswerKind.Taps,
            ExpiresAt = expires,
        }));
    }

    private static void AssertAnswerKind(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        Assert.True(
            root.TryGetProperty("answer_kind", out var value),
            $"the wire field is 'answer_kind', and this body has no such property:\n{json}");

        Assert.Equal(JsonValueKind.String, value.ValueKind);
        Assert.Equal("taps", value.GetString());

        // snake case is the contract; a body carrying both spellings is worse than a wrong one: half the clients would work
        Assert.False(root.TryGetProperty("answerKind", out _), $"camelCase leaked onto the wire:\n{json}");
        Assert.False(root.TryGetProperty("AnswerKind", out _), $"the C# name leaked onto the wire:\n{json}");
    }

    /// every field set, even combinations no challenge uses: a field left at its default proves nothing in a round trip
    private static RaiseChallengeRequest FullyPopulatedRaise() => new()
    {
        Type = ChallengeType.Image,
        AnswerKind = ChallengeAnswerKind.Taps,
        PromptKey = "connect.challenge.captcha",
        ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5),
        Code = "MOCK1",
        Delivery = "sms",
        Length = 5,
        Options = [new ChallengeOption { Value = "a", Label = "Account A" }],
        Url = "https://provider.example/login",
        ReturnPattern = "appie://login-exit*",
        ImageBase64 = Convert.ToBase64String(Png),
    };

    private static ChallengeRow Row(string payloadJson, byte[]? image = null) => new()
    {
        Id = ChallengeId,
        JobId = "job_0123456789abcdef0123456789abcdef",
        Type = ChallengeType.Image,
        PayloadJson = payloadJson,
        ImageBytes = image,
        ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5),
        CreatedAt = DateTimeOffset.UtcNow,
    };

    /// settable public state only: a get-only property (Challenge.IsPassive) is derived, with nothing to propagate
    private static Dictionary<string, Field> FieldsOf(Type type)
    {
        var nullability = new NullabilityInfoContext();
        var fields = new Dictionary<string, Field>(StringComparer.Ordinal);

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.GetMethod is null || property.SetMethod is null) continue;

            fields[property.Name] = new Field(
                property.PropertyType,
                nullability.Create(property).ReadState == NullabilityState.Nullable);
        }

        return fields;
    }

    /// the name that goes on the wire once the naming policy and any explicit JsonPropertyName have had their say
    private static Dictionary<string, WireField> WireFieldsOf(Type type)
    {
        var fields = new Dictionary<string, WireField>(StringComparer.Ordinal);

        foreach (var property in ConnectorWireJson.Options.GetTypeInfo(type).Properties)
        {
            var name = (property.AttributeProvider as MemberInfo)?.Name ?? property.Name;
            fields[name] = new WireField(property.Name, property.IsRequired);
        }

        return fields;
    }

    private static IEnumerable<KeyValuePair<string, Field>> Ordered(Dictionary<string, Field> fields) =>
        fields.OrderBy(f => f.Key, StringComparer.Ordinal);

    private static string Describe(Field field)
    {
        var name = TypeName(field.Type);
        return field.Nullable && !field.Type.IsValueType ? name + "?" : name;
    }

    private static string TypeName(Type type)
    {
        var underlying = Nullable.GetUnderlyingType(type);
        if (underlying is not null) return TypeName(underlying) + "?";

        if (type.IsGenericType)
        {
            var bare = type.Name[..type.Name.IndexOf('`', StringComparison.Ordinal)];
            return $"{bare}<{string.Join(", ", type.GetGenericArguments().Select(TypeName))}>";
        }

        return type.Name switch
        {
            "String" => "string",
            "Int32" => "int",
            "Boolean" => "bool",
            "Byte[]" => "byte[]",
            _ => type.Name,
        };
    }

    private static string Report(string left, string right, IReadOnlyList<string> problems)
    {
        var message = new StringBuilder()
            .AppendLine("These two describe ONE thing and have drifted apart:")
            .AppendLine()
            .Append("  ").AppendLine(left)
            .Append("  ").AppendLine(right)
            .AppendLine();

        foreach (var problem in problems)
        {
            message.Append("  - ").AppendLine(problem).AppendLine();
        }

        return message.ToString();
    }

    /// property order is not the contract: sorting keeps a harmless reordering from reading as a wire change
    private static string Canonical(string json)
    {
        using var document = JsonDocument.Parse(json);
        var sorted = new SortedDictionary<string, JsonNode?>(StringComparer.Ordinal);

        foreach (var property in document.RootElement.EnumerateObject())
        {
            sorted[property.Name] = JsonNode.Parse(property.Value.GetRawText());
        }

        return JsonSerializer.Serialize(sorted, Indented);
    }

    private sealed record Field(Type Type, bool Nullable);

    private sealed record WireField(string WireName, bool Required);
}
