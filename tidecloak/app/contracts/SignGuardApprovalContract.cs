using Ork.Forseti.Sdk;
using Cryptide.Tools;
using Ork.Shared.Models.Contracts;
using System;
using System.Collections.Generic;
using System.Text;

// SignGuard approval contract: OPTIONAL UPGRADE over the built-in GenericRealmAccessThresholdRole:1.
//
// STATUS: compile-checked locally only. Deploying a custom contract is not self-service; it goes to
// the Tide team (info@tide.org, https://discord.gg/XBMd9ny2q5). SignGuard runs today on the built-in
// contract. This one moves the rules the server enforces today onto the network as well:
//
//   built-in contract       counts approvers holding one realm role
//   this contract, adds:    - the statement is a SignGuard approval statement for this band
//                           - the amount is inside the band's range (parsed as digits, no int32)
//                           - every approver is a different person (by vuid)
//                           - the initiator never counts, unless the band allows self-approval
//                           - a two-tier mix (e.g. director AND owner) by Hall's condition
//                           - no approver's doken has expired
//
// One signed policy per band, authorising "Policy:1" (signing the statement), EXPLICIT approval,
// PUBLIC execution. Parameters are strings or ints; 64-bit amounts are strings (long never binds).
//
// Payload layout read below (to confirm with the Tide team for Policy:1 requests):
//   ctx.Data            = request draft      = [ statementPolicy ]
//   statementPolicy     = [ dataToVerify ]
//   dataToVerify        = [ version, contractId, [modelIds], keyId, approvalType, executionType, [params] ]
//   param               = [ name, type, value ]
// No lambdas or LINQ: the ORK's IL vetter rejects them.
public class Contract : IAccessPolicy
{
    private const string StatementModel = "BasicCustom<SignGuardApproval>:BasicCustom<1>";

    [PolicyParam(Required = true, Description = "Band (rule id) this policy authorises, e.g. mid")]
    public string Band { get; set; }

    [PolicyParam(Required = true, Description = "Lowest amount in dong, digits")]
    public string MinAmount { get; set; }

    [PolicyParam(Description = "Highest amount in dong, digits; empty means no upper bound")]
    public string MaxAmount { get; set; } = "";

    [PolicyParam(Required = true, Description = "First realm role approvers must hold, e.g. sg_director")]
    public string RoleA { get; set; }

    [PolicyParam(Default = 1, Min = 1, Max = 5)]
    public int CountA { get; set; }

    [PolicyParam(Description = "Second realm role, e.g. sg_owner; empty for none")]
    public string RoleB { get; set; } = "";

    [PolicyParam(Default = 0, Min = 0, Max = 5)]
    public int CountB { get; set; }

    [PolicyParam(AllowedValues = new[] { "yes", "no" }, Description = "Low band only: the drafter may approve alone")]
    public string InitiatorMayApprove { get; set; } = "no";

    // Captured in ValidateData, read in ValidateApprovers (the contexts are disjoint).
    private bool dataChecked;
    private string initiator = "";

    public PolicyDecision ValidateData(DataContext ctx)
    {
        dataChecked = false;
        ReadOnlyMemory<byte> data = ctx.Data;
        if (data.Length == 0) return PolicyDecision.Deny("No statement in the request");

        ReadOnlyMemory<byte> statement;
        if (!data.TryGetValue(0, out statement)) return PolicyDecision.Deny("No statement in the request");
        ReadOnlyMemory<byte> body;
        if (!statement.TryGetValue(0, out body)) return PolicyDecision.Deny("Statement has no body");

        ReadOnlyMemory<byte> models;
        if (!body.TryGetValue(2, out models)) return PolicyDecision.Deny("Statement has no model");
        ReadOnlyMemory<byte> model;
        if (!models.TryGetValue(0, out model) || Text(model) != StatementModel) return PolicyDecision.Deny("Not a SignGuard approval statement");

        ReadOnlyMemory<byte> parameters;
        if (!body.TryGetValue(6, out parameters)) return PolicyDecision.Deny("Statement has no parameters");

        string band = "";
        string amount = "";
        string hash = "";
        string who = "";
        ReadOnlyMemory<byte> param;
        for (int i = 0; parameters.TryGetValue(i, out param); i++)
        {
            ReadOnlyMemory<byte> name;
            ReadOnlyMemory<byte> value;
            if (!param.TryGetValue(0, out name) || !param.TryGetValue(2, out value)) return PolicyDecision.Deny("Malformed parameter");
            string key = Text(name);
            if (key == "band") band = Text(value);
            else if (key == "amount") amount = Text(value);
            else if (key == "contenthash") hash = Text(value);
            else if (key == "initiator") who = Text(value);
        }

        if (band != Band) return PolicyDecision.Deny("Statement is for a different band");
        if (!IsHex64(hash)) return PolicyDecision.Deny("Statement has no valid content hash");
        if (who.Length == 0) return PolicyDecision.Deny("Statement names no initiator");
        if (!IsDigits(amount)) return PolicyDecision.Deny("Amount is not a whole number of dong");
        if (CompareDigits(amount, MinAmount) < 0) return PolicyDecision.Deny("Amount is below this band");
        if (MaxAmount.Length > 0 && CompareDigits(amount, MaxAmount) > 0) return PolicyDecision.Deny("Amount is above this band");

        initiator = who;
        dataChecked = true;
        return PolicyDecision.Allow();
    }

    public PolicyDecision ValidateApprovers(ApproversContext ctx)
    {
        // "The data check did not run" can only mean refuse.
        if (!dataChecked) return PolicyDecision.Deny("Statement was not validated");

        List<DokenDto> approvers = DokenDto.WrapAll(ctx.Dokens);
        List<string> seen = new List<string>();
        int holdersA = 0;
        int holdersB = 0;
        int holdersEither = 0;
        bool selfAllowed = InitiatorMayApprove == "yes";

        for (int i = 0; i < approvers.Count; i++)
        {
            DokenDto d = approvers[i];
            if (d.IsNull || d.IsExpired) return PolicyDecision.Deny("An approval has expired");
            string id = d.UserId;
            if (id.Length == 0) return PolicyDecision.Deny("An approval has no identity");
            if (seen.Contains(id)) return PolicyDecision.Deny("The same person approved twice");
            seen.Add(id);
            if (id == initiator && !selfAllowed) return PolicyDecision.Deny("The initiator cannot approve their own request");

            bool a = d.HasRole(RoleA);
            bool b = RoleB.Length > 0 && d.HasRole(RoleB);
            if (a) holdersA++;
            if (b) holdersB++;
            if (a || b) holdersEither++;
        }

        // Hall's condition for two tiers: enough holders of each, and enough distinct people overall.
        return Decision
            .Require(holdersA >= CountA, "Not enough approvals from " + RoleA)
            .Require(RoleB.Length == 0 || holdersB >= CountB, "Not enough approvals from " + RoleB)
            .Require(holdersEither >= CountA + CountB, "Not enough different people approved");
    }

    private static string Text(ReadOnlyMemory<byte> b)
    {
        return Encoding.UTF8.GetString(b.Span);
    }

    private static bool IsDigits(string s)
    {
        if (s.Length == 0 || s.Length > 18) return false;
        if (s.Length > 1 && s[0] == '0') return false;
        for (int i = 0; i < s.Length; i++)
        {
            if (s[i] < '0' || s[i] > '9') return false;
        }
        return true;
    }

    // Compare two canonical digit strings without parsing, so no culture or overflow is involved.
    private static int CompareDigits(string a, string b)
    {
        if (a.Length != b.Length) return a.Length < b.Length ? -1 : 1;
        return string.CompareOrdinal(a, b);
    }

    private static bool IsHex64(string s)
    {
        if (s.Length != 64) return false;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) return false;
        }
        return true;
    }
}
