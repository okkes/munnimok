using System.Text.Json;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// What the reference says each route answers with.
///
/// Every one of the 36 operations used to document a bodyless 200. Request
/// bodies, path parameters and query parameters were all inferred perfectly;
/// responses alone were empty, because minimal APIs read the handler's DECLARED
/// return type and every helper in this service returned <c>IResult</c>. A
/// reference that names what to send and stays silent about what comes back is
/// the half a caller cannot guess from a curl.
///
/// The assertions are exact <c>$ref</c> strings rather than substring checks.
/// The two that existed before this file - "the document mentions /v1/health"
/// and "/v1/providers" - passed happily while every response in it was empty,
/// which is the failure mode a document test exists to catch.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class ApiDocumentTests(ShopApiFactory factory)
{
    /// <summary>
    /// Routes whose success carries no body at all, and why. Anything outside
    /// this list that documents an empty success is a route nobody annotated -
    /// which is exactly the state the whole service was in.
    /// </summary>
    private static readonly HashSet<string> BodylessOnPurpose = new(StringComparer.Ordinal)
    {
        // A frame the agent posted. 200 either way, and deliberately empty: a
        // stale frame is the network's fault, and an error would make an agent
        // retry a photograph that is already out of date.
        "post /agent/v1/jobs/{jobId}/live/frame 200",
    };

    private async Task<JsonElement> DocumentAsync()
    {
        using var http = factory.CreateClient();
        using var stream = await http.GetStreamAsync("/openapi/v1.json");
        using var parsed = await JsonDocument.ParseAsync(stream);
        return parsed.RootElement.Clone();
    }

    private static JsonElement Response(JsonElement document, string path, string method, string status) =>
        document.GetProperty("paths").GetProperty(path).GetProperty(method).GetProperty("responses")
            .GetProperty(status);

    // ---- the bodies --------------------------------------------------------

    [Theory]
    // The catalogue, health and the kill switch.
    [InlineData("/v1/health", "get", "200", "HealthResponse")]
    [InlineData("/v1/providers", "get", "200", "CatalogResponse")]
    [InlineData("/v1/status", "get", "200", "StatusResponse")]
    [InlineData("/v1/admin/providers/{id}/status", "post", "200", "ProviderStatus")]
    // Connecting. The 202 is the same body under a different promise: poll or
    // subscribe rather than "the bundle is in your hands".
    [InlineData("/v1/{provider}/login", "post", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/login", "post", "202", "SessionResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}", "get", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}/answer", "post", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}/cancel", "post", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/sessions/resume", "post", "200", "ResumeResponse")]
    // Fetching: the data, or a handle to the job still producing it.
    [InlineData("/v1/{provider}/{resource}", "get", "200", "DataResponse")]
    [InlineData("/v1/{provider}/{resource}", "get", "202", "JobAcceptedResponse")]
    [InlineData("/v1/{provider}/{resource}:fetch", "post", "200", "DataResponse")]
    [InlineData("/v1/{provider}/{resource}:fetch", "post", "202", "JobAcceptedResponse")]
    [InlineData("/v1/{provider}/{resource}/ack", "post", "200", "AckResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}", "get", "200", "JobResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}/answer", "post", "200", "JobResponse")]
    // Bring-your-own agents, from the consumer's side.
    [InlineData("/v1/agents", "get", "200", "AgentListResponse")]
    [InlineData("/v1/agents/enrollment", "post", "200", "AgentEnrollmentResponse")]
    // The agent protocol.
    [InlineData("/agent/v1/enroll", "post", "200", "EnrollResponse")]
    [InlineData("/agent/v1/heartbeat", "post", "200", "HeartbeatResponse")]
    [InlineData("/agent/v1/jobs/lease", "post", "200", "LeasedJob")]
    [InlineData("/agent/v1/jobs/{jobId}/renew", "post", "200", "RenewResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/challenge", "post", "200", "RaiseChallengeResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/answer", "get", "200", "ChallengeAnswer")]
    [InlineData("/agent/v1/jobs/{jobId}/result", "post", "200", "AgentAckResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/fail", "post", "200", "AgentFailResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/live/input", "get", "200", "LiveInputBatch")]
    public async Task A_json_route_names_the_schema_it_returns(
        string path, string method, string status, string schema)
    {
        var document = await DocumentAsync();

        var body = Response(document, path, method, status)
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal($"#/components/schemas/{schema}", body.GetProperty("$ref").GetString());
    }

    [Theory]
    // A stream of the very view the poll returns, one per event. Without the
    // frame type a consumer is told a subscription returns nothing.
    [InlineData("/v1/{provider}/login/{sessionId}/events", "get", "text/event-stream", "SessionResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}/events", "get", "text/event-stream", "JobResponse")]
    public async Task A_stream_names_its_media_type_and_the_view_it_carries(
        string path, string method, string mediaType, string schema)
    {
        var document = await DocumentAsync();

        var content = Response(document, path, method, "200").GetProperty("content");

        // The media type is the assertion: documenting a 10-minute event
        // stream as application/json would send a consumer to read it wrong.
        Assert.Equal(mediaType, Assert.Single(content.EnumerateObject()).Name);
        Assert.Equal(
            $"#/components/schemas/{schema}",
            content.GetProperty(mediaType).GetProperty("schema").GetProperty("$ref").GetString());
    }

    [Theory]
    // A relayed captcha, and a live login's frames. Bytes, not JSON.
    [InlineData("/v1/{provider}/login/{sessionId}/challenges/{challengeId}/image", "image/png")]
    [InlineData("/v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/frame", "image/jpeg")]
    public async Task A_picture_is_documented_as_binary_under_its_own_media_type(string path, string mediaType)
    {
        var document = await DocumentAsync();

        var content = Response(document, path, "get", "200").GetProperty("content");

        // Under its own media type and no other: a picture offered as
        // application/json is a consumer trying to parse a PNG.
        Assert.Equal(mediaType, Assert.Single(content.EnumerateObject()).Name);

        var schema = content.GetProperty(mediaType).GetProperty("schema");
        Assert.Equal("string", schema.GetProperty("type").GetString());
        Assert.Equal("byte", schema.GetProperty("format").GetString());
    }

    /// <summary>
    /// The manifest is serialised through a node so the document's shape stays
    /// the spec's, so there is no C# type to point at - and the list endpoint
    /// has always declared its providers the same free-form way.
    /// </summary>
    [Fact]
    public async Task A_manifest_is_documented_as_the_free_form_object_it_is()
    {
        var document = await DocumentAsync();

        var schema = Response(document, "/v1/providers/{id}", "get", "200")
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal("#/components/schemas/JsonObject", schema.GetProperty("$ref").GetString());

        // And that schema really is open: an object with no declared
        // properties, which is the honest description of a document whose
        // shape is the manifest spec's rather than ours.
        var jsonObject = document.GetProperty("components").GetProperty("schemas").GetProperty("JsonObject");
        Assert.Equal("object", jsonObject.GetProperty("type").GetString());
        Assert.False(jsonObject.TryGetProperty("properties", out _));
    }

    [Fact]
    public async Task A_list_of_profiles_is_documented_as_an_array_of_them()
    {
        var document = await DocumentAsync();

        var schema = Response(document, "/v1/agents/{agentId}/profiles", "get", "200")
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal("array", schema.GetProperty("type").GetString());
        Assert.Equal(
            "#/components/schemas/ProfileView",
            schema.GetProperty("items").GetProperty("$ref").GetString());
    }

    // ---- the records -------------------------------------------------------

    /// <summary>
    /// The question the reference could not answer.
    ///
    /// Every route named its envelope and then described <c>data</c> as an
    /// array of anything, because the handler hands back a JsonArray and the
    /// generator reads the declared return type. So "what comes back when I
    /// fetch receipts" had no answer here, and the only way to find out was to
    /// connect a real account to a real shop and look at what arrived.
    ///
    /// The shape was never unknown - a manifest states it per resource as
    /// <c>returns</c> - it just resolved to nothing. Now it resolves to a
    /// model.
    /// </summary>
    [Theory]
    [InlineData("/v1/{provider}/{resource}", "get", "200", "DataResponse")]
    [InlineData("/v1/{provider}/{resource}:fetch", "post", "200", "DataResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}", "get", "200", "JobResponse")]
    public async Task A_fetch_names_the_record_it_hands_back(
        string path, string method, string status, string envelope)
    {
        var document = await DocumentAsync();

        // Through the route, not straight to the component: what is being
        // asserted is that somebody reading THIS operation in the reference
        // arrives at the model.
        var body = Response(document, path, method, status)
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal($"#/components/schemas/{envelope}", body.GetProperty("$ref").GetString());

        var rows = document.GetProperty("components").GetProperty("schemas")
            .GetProperty(envelope).GetProperty("properties").GetProperty("data");

        // One control plane hosts every pack, so the rows are one of the
        // records its providers return — and a receipt is among them.
        var options = rows.GetProperty("items").GetProperty("oneOf").EnumerateArray()
            .Select(option => option.GetProperty("$ref").GetString())
            .ToList();
        Assert.Contains("#/components/schemas/Receipt", options);

        // And the description carries the manifest's own word for it, so a
        // reader who saw `returns: "receipt"` in the catalogue can join the two
        // without being told the naming convention.
        Assert.Contains("`receipt`", rows.GetProperty("description").GetString()!, StringComparison.Ordinal);
    }

    /// <summary>
    /// The reference offers exactly the shapes the registered manifests
    /// return — no more (a shape no provider hands back would describe an API
    /// this control plane does not serve) and no less (a provider's rows must
    /// be readable from the document alone). The set comes off the catalogue,
    /// not off a list written here, so a provider pack that starts returning
    /// a new record is held to this on the day it lands.
    /// </summary>
    [Fact]
    public async Task A_service_offers_exactly_the_shapes_its_own_providers_return()
    {
        var document = await DocumentAsync();

        using var http = factory.CreateAuthorizedClient();
        using var response = await http.GetAsync("/v1/providers");
        var providers = (await response.JsonAsync()).GetProperty("providers");
        var returned = providers.EnumerateArray()
            .SelectMany(provider => provider.GetProperty("resources").EnumerateArray())
            .Select(resource => resource.GetProperty("returns").GetString()!)
            .Distinct()
            .OrderBy(word => word, StringComparer.Ordinal)
            .ToList();
        Assert.True(returned.Count > 1, "the unified control plane serves more than one record shape");

        var data = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("DataResponse").GetProperty("properties").GetProperty("data");
        var offered = data.GetProperty("items").GetProperty("oneOf").EnumerateArray()
            .Select(option => option.GetProperty("$ref").GetString()!.Split('/').Last())
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        // the wire word (snake_case) and the schema name (PascalCase) are the same shape
        static string Pascal(string word) => string.Concat(word.Split('_').Select(part => char.ToUpperInvariant(part[0]) + part[1..]));
        Assert.Equal(returned.Select(Pascal).OrderBy(name => name, StringComparer.Ordinal).ToList(), offered);

        var description = data.GetProperty("description").GetString()!;
        foreach (var word in returned) Assert.Contains($"`{word}`", description, StringComparison.Ordinal);
    }

    /// <summary>
    /// A job that has not finished has no rows yet, and the document said so
    /// before the records were pointed at. Describing what is IN the array must
    /// not quietly change whether there is one.
    /// </summary>
    [Fact]
    public async Task A_jobs_rows_may_still_be_absent()
    {
        var document = await DocumentAsync();

        var types = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("JobResponse").GetProperty("properties").GetProperty("data")
            .GetProperty("type").EnumerateArray().Select(t => t.GetString()).ToList();

        Assert.Contains("array", types);
        Assert.Contains("null", types);

        // The fetch envelope is the other half: `data` is required there, and a
        // 200 that carried none would be a lie of its own.
        var required = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("DataResponse").GetProperty("required")
            .EnumerateArray().Select(r => r.GetString()).ToList();

        Assert.Contains("data", required);
    }

    /// <summary>
    /// The model itself, in the names that go on the wire - and with the two
    /// fields a consumer most needs and would never guess: whether the lines
    /// reconcile, and whether the total is one the shop stated or one this
    /// connector summed.
    /// </summary>
    [Fact]
    public async Task The_published_record_is_described_as_it_is_serialised()
    {
        var document = await DocumentAsync();

        var receipt = document.GetProperty("components").GetProperty("schemas").GetProperty("Receipt");
        var properties = receipt.GetProperty("properties").EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("external_id", properties);
        Assert.Contains("purchased_at", properties);
        Assert.Contains("content_hash", properties);
        Assert.Contains("total_is_derived", properties);
        Assert.Contains("reconciled", properties);

        // The camelCase a default generator would have produced, and which the
        // service never sends.
        Assert.DoesNotContain("externalId", properties);
        Assert.DoesNotContain("totalIsDerived", properties);

        // Nested records resolve too, so a reader can walk from a receipt to
        // what a line on it looks like rather than finding a bare object.
        Assert.Equal(
            "#/components/schemas/ReceiptItem",
            receipt.GetProperty("properties").GetProperty("items")
                .GetProperty("items").GetProperty("$ref").GetString());
    }

    /// <summary>
    /// Every <c>$ref</c> in the document names a component that is in it.
    ///
    /// The reason it can fail: a schema pointed at from a route is not
    /// necessarily one the generator emitted. It walks handler signatures, and
    /// the records are put in by a transformer - so a service that never maps
    /// the agent routes, which are the only other place a Receipt is mentioned,
    /// would carry a fetch route pointing at nothing. A reference with a
    /// dangling pointer is worse than one with a gap: the gap is visible.
    /// </summary>
    [Fact]
    public async Task Every_reference_in_the_document_resolves()
    {
        var document = await DocumentAsync();
        var schemas = document.GetProperty("components").GetProperty("schemas");

        var dangling = new SortedSet<string>(StringComparer.Ordinal);
        var seen = 0;

        void Walk(JsonElement node)
        {
            switch (node.ValueKind)
            {
                case JsonValueKind.Object:
                    foreach (var property in node.EnumerateObject())
                    {
                        if (property.NameEquals("$ref") && property.Value.GetString() is { } reference)
                        {
                            seen++;
                            var name = reference[(reference.LastIndexOf('/') + 1)..];
                            if (!schemas.TryGetProperty(name, out _)) dangling.Add(reference);
                        }

                        Walk(property.Value);
                    }

                    break;

                case JsonValueKind.Array:
                    foreach (var item in node.EnumerateArray()) Walk(item);
                    break;

                default:
                    break;
            }
        }

        Walk(document);

        Assert.Empty(dangling);

        // A walk that found nothing would pass for the wrong reason.
        Assert.True(seen > 50, $"only {seen} references in the whole document?");
    }

    // ---- the statuses ------------------------------------------------------

    [Theory]
    // Each of these returns 204 and nothing else. The default inference claims
    // a 200 for any handler it cannot read, so until they were annotated the
    // document promised a body on routes that never send one.
    //
    // The disconnect USED to be one of them and has left the list on purpose:
    // answering 204 in every case is exactly what left a consumer with nothing
    // to report but the manifest's claim, and it told people their bank had
    // been signed out of over disconnects that dispatched nothing at all. It
    // now answers 200 with `logged_out`.
    [InlineData("/v1/agents/{agentId}", "delete")]
    [InlineData("/agent/v1/jobs/{jobId}/progress", "post")]
    public async Task A_route_that_only_ever_returns_204_does_not_advertise_a_200(string path, string method)
    {
        var document = await DocumentAsync();

        var responses = Response(document, path, method, "204");
        Assert.False(responses.TryGetProperty("content", out _));

        var codes = document.GetProperty("paths").GetProperty(path).GetProperty(method)
            .GetProperty("responses").EnumerateObject().Select(p => p.Name);

        Assert.DoesNotContain("200", codes);
    }

    /// <summary>
    /// The guard against route thirty-seven. A new endpoint that never says
    /// what it returns lands here rather than in the reference, silently
    /// documented as answering nothing.
    /// </summary>
    [Fact]
    public async Task No_route_documents_a_success_with_no_body_unless_it_has_none()
    {
        var document = await DocumentAsync();

        var empty = new List<string>();
        var operations = 0;

        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                operations++;

                foreach (var response in operation.Value.GetProperty("responses").EnumerateObject())
                {
                    // 204 and 202 say "no body" by their own meaning; every
                    // other success is a promise of one.
                    if (!response.Name.StartsWith('2') || response.Name.Length != 3) continue;
                    if (response.Name is "204" or "202") continue;
                    if (response.Value.TryGetProperty("content", out _)) continue;

                    empty.Add($"{operation.Name} {path.Name} {response.Name}");
                }
            }
        }

        Assert.Equal(BodylessOnPurpose, empty.ToHashSet(StringComparer.Ordinal));

        // The count is asserted so a route that vanishes from the document is
        // as loud as one that arrives undocumented. 41 since the operator's
        // two fleet routes: list every agent, revoke any. 45 since the lookup
        // field's options and logo and the operator's remote inventory (#414).
        Assert.Equal(45, operations);
    }

    [Theory]
    [InlineData("400")]
    [InlineData("401")]
    [InlineData("500")]
    public async Task Every_public_route_documents_the_envelope_it_fails_into(string status)
    {
        var document = await DocumentAsync();

        var missing = new List<string>();

        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            // The /v1 group is where the exception filter lives, so it is the
            // group whose failure shape is a promise. Liveness is mapped on the
            // root instead - it carries no auth and no data on purpose, so it
            // sits outside both filters and has no envelope to promise.
            if (!path.Name.StartsWith("/v1/", StringComparison.Ordinal)) continue;
            if (path.Name == "/v1/health") continue;

            foreach (var operation in path.Value.EnumerateObject())
            {
                var found = operation.Value.GetProperty("responses")
                    .TryGetProperty(status, out var response)
                    && response.GetProperty("content").GetProperty("application/json")
                        .GetProperty("schema").GetProperty("$ref").GetString()
                    == "#/components/schemas/ConnectorErrorEnvelope";

                if (!found) missing.Add($"{operation.Name} {path.Name}");
            }
        }

        Assert.Empty(missing);
    }

    /// <summary>
    /// The other half of the rule above, asserted rather than assumed: liveness
    /// answers one way and one way only. A probe that needs a credential is a
    /// probe that fails for the wrong reason, so it is mapped outside the group
    /// that owns the envelope - and the document should say so.
    /// </summary>
    [Fact]
    public async Task Liveness_promises_nothing_but_the_one_answer_it_gives()
    {
        var document = await DocumentAsync();

        var codes = document.GetProperty("paths").GetProperty("/v1/health").GetProperty("get")
            .GetProperty("responses").EnumerateObject().Select(p => p.Name);

        Assert.Equal("200", Assert.Single(codes));
    }

    // ---- the encoding ------------------------------------------------------

    /// <summary>
    /// The schema generator reads the JSON options registered in DI, never the
    /// ones handed to <c>Results.Json</c>. So this passes only because
    /// <c>AddConnectorPlatform</c> copies the wire policy into
    /// <c>ConfigureHttpJsonOptions</c> - and without it the document would
    /// confidently describe every field under a name the service never sends,
    /// which is worse than describing no body at all.
    /// </summary>
    [Fact]
    public async Task The_documented_field_names_are_the_ones_that_go_on_the_wire()
    {
        var document = await DocumentAsync();

        var properties = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("SessionResponse").GetProperty("properties")
            .EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("session_id", properties);
        Assert.Contains("expires_at", properties);
        Assert.Contains("provider_account", properties);

        // The camelCase a default generator would have produced.
        Assert.DoesNotContain("sessionId", properties);
        Assert.DoesNotContain("expiresAt", properties);
        Assert.DoesNotContain("providerAccount", properties);
    }

    [Fact]
    public async Task The_documented_enum_members_are_the_ones_that_go_on_the_wire()
    {
        var document = await DocumentAsync();

        var members = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("JobStep").GetProperty("enum")
            .EnumerateArray().Select(m => m.GetString()).ToList();

        // snake_case, from the converter the wire policy carries. A document
        // naming these "OpeningProvider" describes an API this service does
        // not serve.
        Assert.Contains("opening_provider", members);
        Assert.Contains("awaiting_human", members);
        Assert.DoesNotContain("OpeningProvider", members);
    }
}
