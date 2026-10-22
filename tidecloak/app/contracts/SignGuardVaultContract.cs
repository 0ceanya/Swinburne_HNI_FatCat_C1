using Ork.Forseti.Sdk;
using Cryptide.Tools;
using Ork.Shared.Models.Contracts;
using System;
using System.Collections.Generic;
using System.Text;

// SignGuard vault contract: OPTIONAL UPGRADE over the built-in GenericRealmAccessThresholdRole:1.
//
// STATUS: compile-checked with the local harness (contracts/harness/check.sh) only. Deploying a
// custom contract is not self-service; it goes to the Tide team (info@tide.org). SignGuard runs
// today on the built-in contract, which counts approver dokens holding one realm role. This one
// enforces the same quorum and adds what the built-in contract does not:
//
//   - every approver is a DIFFERENT person (by vuid): one person's approval copied N times never counts as N
//   - the request seals or unlocks exactly one value, tagged for the SignGuard vault
//   - no approval has expired
//   - whoever executes (commits) the request is one of its approvers: in SignGuard that is the
//     requester, who approves last in their own browser. Someone who never approved cannot take a
//     fully approved request and decrypt it.
//
// One signed policy per quorum size, authorising PolicyEnabledEncryption:1 and
// PolicyEnabledDecryption:1, EXPLICIT approval, PRIVATE execution (so ValidateExecutor runs).
//
// Payload layout read below (from @tideorg/js PolicyAuthorizedEncryptionFlow):
//   encryption: ctx.Data = [ timestamp, [ C1, authData, ...tags ] ]
//   decryption: ctx.Data = [ [ C1, signature, timestamp, ...tags ] ]
// No lambdas, LINQ or static field initialisers: the ORK's IL vetter rejects them.
public class Contract : IAccessPolicy
{
    private const string VaultTag = "signguard-vault-v1";
    private const string EncryptionModel = "PolicyEnabledEncryption:1";
    private const string DecryptionModel = "PolicyEnabledDecryption:1";

    [PolicyParam(Required = true, Description = "Realm role every board member holds, e.g. sg_viewer")]
    public string Role { get; set; }

    [PolicyParam(Default = 1, Min = 1, Max = 10, Description = "Distinct board members who must approve, the requester included")]
    public int Threshold { get; set; }

    // Captured in one stage, read in the next (the contexts are disjoint).
    private bool dataChecked;
    private List<string> approverIds = new();

    public PolicyDecision ValidateData(DataContext ctx)
    {
        dataChecked = false;
        bool encryption;
        if (ctx.RequestId == EncryptionModel) encryption = true;
        else if (ctx.RequestId == DecryptionModel) encryption = false;
        else return PolicyDecision.Deny("This contract only seals and unlocks SignGuard vault keys");

        if (ctx.Policy.ApprovalType != ApprovalType.EXPLICIT || ctx.Policy.ExecutionType != ExecutionType.PRIVATE)
        {
            return PolicyDecision.Deny("A vault policy must be EXPLICIT and PRIVATE");
        }

        ReadOnlyMemory<byte> data = ctx.Data;
        if (data.Length == 0) return PolicyDecision.Deny("The request carries no value");

        ReadOnlyMemory<byte> entry;
        int firstTag;
        ReadOnlyMemory<byte> extra;
        if (encryption)
        {
            if (!data.TryGetValue(1, out entry)) return PolicyDecision.Deny("The request carries no value");
            if (data.TryGetValue(2, out extra)) return PolicyDecision.Deny("Seal exactly one value per request");
            firstTag = 2;
        }
        else
        {
            if (!data.TryGetValue(0, out entry)) return PolicyDecision.Deny("The request carries no value");
            if (data.TryGetValue(1, out extra)) return PolicyDecision.Deny("Unlock exactly one value per request");
            firstTag = 3;
        }

        int tags = 0;
        ReadOnlyMemory<byte> tag;
        for (int i = firstTag; entry.TryGetValue(i, out tag); i++)
        {
            if (Encoding.UTF8.GetString(tag.Span) != VaultTag) return PolicyDecision.Deny("The value is not tagged for the SignGuard vault");
            tags++;
        }
        if (tags != 1) return PolicyDecision.Deny("The value must carry exactly the SignGuard vault tag");

        dataChecked = true;
        return PolicyDecision.Allow();
    }

    public PolicyDecision ValidateApprovers(ApproversContext ctx)
    {
        // "The data check did not run" can only mean refuse.
        if (!dataChecked) return PolicyDecision.Deny("The request was not validated");

        List<DokenDto> approvers = DokenDto.WrapAll(ctx.Dokens);
        approverIds = new List<string>();
        for (int i = 0; i < approvers.Count; i++)
        {
            DokenDto d = approvers[i];
            if (d.IsNull || d.IsExpired) return PolicyDecision.Deny("An approval has expired");
            string id = d.UserId;
            if (id.Length == 0) return PolicyDecision.Deny("An approval has no identity");
            if (approverIds.Contains(id)) return PolicyDecision.Deny("The same person approved twice");
            if (!d.HasRole(Role)) return PolicyDecision.Deny("An approver is not on the board");
            approverIds.Add(id);
        }

        return Decision.Require(approverIds.Count >= Threshold, "Not enough board members approved");
    }

    public PolicyDecision ValidateExecutor(ExecutorContext ctx)
    {
        DokenDto executor = new DokenDto(ctx.Doken);
        if (executor.IsNull || executor.IsExpired) return PolicyDecision.Deny("The executor's session has expired");
        return Decision.Require(approverIds.Contains(executor.UserId), "Only someone who approved this request can complete it");
    }
}
